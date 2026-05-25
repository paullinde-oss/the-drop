// fetch-movies.js
// Runs via GitHub Action nightly — fetches TMDb data and writes movies.json

const fs = require('fs');

const TOKEN = process.env.TMDB_TOKEN;
if (!TOKEN) { console.error('Missing TMDB_TOKEN env var'); process.exit(1); }

const HEADERS = {
  'Authorization': 'Bearer ' + TOKEN,
  'Content-Type': 'application/json'
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function tmdb(path) {
  const res = await fetch('https://api.themoviedb.org/3' + path, { headers: HEADERS });
  if (!res.ok) throw new Error('TMDb ' + res.status + ' for ' + path);
  return res.json();
}

// ── STUDIO WHITELIST ──────────────────────────────────────────────────────────
const STUDIOS = [
  // Major Hollywood
  'walt disney','warner bros','universal pictures','sony pictures',
  'paramount pictures','new line cinema','columbia pictures','tristar pictures',
  'screen gems','metro-goldwyn-mayer','mgm','castle rock','rko pictures',
  // Streaming
  'netflix','amazon mgm','apple original',
  // Prestige / Indie / Mini-Majors
  'lionsgate','a24','neon','blumhouse','annapurna','ifc films','magnolia',
  'vertical','angel studios','xyz films','legendary','miramax','studiocanal',
  'pathe','gaumont','focus features','searchlight','working title','skydance',
  // Animation
  'dreamworks animation','pixar','laika','aardman',
  // IP & Franchise
  'lucasfilm','marvel studios','dc studios',
  // International
  'toho','shochiku',
  // Common short-forms to catch variants
  'disney','warner','universal','paramount','sony','amazon','apple',
  'dreamworks','20th century','searchlight pictures'
];

function hasWhitelistedStudio(companies) {
  if (!companies || !companies.length) return false;
  return companies.some(c => {
    const n = (c.name || '').toLowerCase();
    return STUDIOS.some(s => n.includes(s));
  });
}

// ── NOISE EXCLUSIONS ──────────────────────────────────────────────────────────
const EXCLUDE_KEYWORDS = [
  'student film','student project','test film','test movie','adult film',
  'xxx','porn','pornographic','amateur','thesis film','film school project',
  'concert film','live recording','live performance','theatrical recording',
  'sporting event'
];

function isNoise(m, details) {
  // Exclude films with India as country of origin
  if (details) {
    const countries = (details.production_countries || []).map(c => c.iso_3166_1);
    if (countries.length > 0 && countries.every(c => c === 'IN')) return true;
  }

  const title = (m.title || '').toLowerCase();
  const overview = (m.overview || '').toLowerCase();
  const runtime = details ? (details.runtime || 0) : 0;
  const genres = details ? (details.genres || []).map(g => g.name.toLowerCase()) : [];

  // Exclude short films
  if (runtime > 0 && runtime < 70) return true;

  // Exclude by keyword in title/overview
  if (EXCLUDE_KEYWORDS.some(k => title.includes(k) || overview.includes(k))) return true;

  // Exclude documentaries unless high popularity
  if (genres.includes('documentary') && (m.popularity || 0) < 15) return true;

  return false;
}

// ── RE-RELEASE DETECTION ─────────────────────────────────────────────────────
const RERELEASE_KEYWORDS = [
  're-release','re release','rerelease','anniversary','remaster',
  'restoration','4k restoration','director','special screening',
  'limited engagement','special edition','extended cut'
];

function detectReRelease(relDatesArr) {
  return relDatesArr.some(d => {
    const note = (d.note || '').toLowerCase();
    return RERELEASE_KEYWORDS.some(k => note.includes(k));
  });
}

// ── SELECTION CRITERIA (OR logic) ────────────────────────────────────────────
function meetsSelectionCriteria(m, details, credits) {
  const pop = m.popularity || 0;
  const votes = m.vote_count || 0;
  const companies = details ? (details.production_companies || []) : (m.production_companies || []);

  // 1. Studio whitelist
  if (hasWhitelistedStudio(companies)) return true;

  // 2. High popularity / anticipation
  if (pop >= 30) return true;
  if (votes >= 100) return true;

  // 3. Major director (TMDb popularity of director > 10)
  if (credits) {
    const directors = (credits.crew || []).filter(c => c.job === 'Director');
    if (directors.some(d => (d.popularity || 0) >= 10)) return true;
  }

  // 4. Star power — top 3 billed cast with popularity > 15
  if (credits) {
    const topCast = (credits.cast || []).slice(0, 3);
    if (topCast.some(c => (c.popularity || 0) >= 15)) return true;
  }

  // 5. Festival acquisition title — no studio but premiered at major festival
  const overview = (m.overview || '').toLowerCase();
  const festivalKeywords = ['sundance','cannes','tiff','venice','telluride','berlin','tribeca'];
  if (festivalKeywords.some(f => overview.includes(f))) return true;

  return false;
}

// ── MAIN FETCH ───────────────────────────────────────────────────────────────
async function fetchAllMovies() {
  const today = new Date();
  const fmt = d => d.toISOString().split('T')[0];
  const todayStr = fmt(today);
  const currentYear = today.getFullYear();

  // Monthly windows — 5 years
  const windows = [];
  const cursor = new Date(today.getFullYear(), today.getMonth(), 1);
  for (let i = 0; i < 60; i++) {
    const start = new Date(cursor);
    const end = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    windows.push({ gte: fmt(start), lte: fmt(end) });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  let allRaw = [];

  // Pass 1 — Monthly discovery (both US and CA regions)
  console.log('Pass 1: Monthly discovery...');
  for (let wi = 0; wi < windows.length; wi++) {
    const { gte, lte } = windows[wi];
    const monthLabel = gte.slice(0, 7);

    for (const region of ['US', 'CA']) {
      let page = 1, totalPages = 1;
      while (page <= totalPages && page <= 50) {
        const p = new URLSearchParams({
          region,
          'primary_release_date.gte': gte,
          'primary_release_date.lte': lte,
          sort_by: 'primary_release_date.asc',
          'with_release_type': '1|2|3|4|5',
          page
        });
        try {
          const data = await tmdb('/discover/movie?' + p);
          totalPages = Math.min(data.total_pages || 1, 50);
          allRaw.push(...(data.results || []));
          console.log(`  ${monthLabel} [${region}] page ${page}/${totalPages}`);
        } catch(e) {
          console.warn(`  Skip ${monthLabel} [${region}] p${page}: ${e.message}`);
          break;
        }
        page++;
        if (page <= totalPages) await sleep(40);
      }
      await sleep(40);
    }
  }

  // Pass 2 — Studio guarantee (search by company ID per studio per year)
  console.log('\nPass 2: Studio guarantee...');
  const STUDIO_SEARCH_TERMS = [
    'Marvel Studios','DC Studios','Pixar','DreamWorks Animation','Lucasfilm',
    'Blumhouse Productions','A24','Neon','Annapurna Pictures','Universal Pictures',
    'Warner Bros. Pictures','Walt Disney Pictures','Paramount Pictures',
    'Sony Pictures Entertainment','Lionsgate','Skydance Media','Legendary Entertainment',
    'New Line Cinema','Focus Features','Searchlight Pictures','Apple Original Films',
    'Amazon MGM Studios','Netflix','Angel Studios','Laika','Aardman Animations',
    'Working Title Films','Miramax','StudioCanal','Toho','Yash Raj Films'
  ];

  for (const studioName of STUDIO_SEARCH_TERMS) {
    try {
      const compRes = await tmdb('/search/company?query=' + encodeURIComponent(studioName));
      const comp = (compRes.results || [])[0];
      if (!comp) continue;
      for (let yr = currentYear; yr <= currentYear + 4; yr++) {
        const p = new URLSearchParams({
          'primary_release_date.gte': yr + '-01-01',
          'primary_release_date.lte': yr + '-12-31',
          sort_by: 'primary_release_date.asc',
          with_companies: comp.id,
          page: 1
        });
        const res = await tmdb('/discover/movie?' + p);
        const results = res.results || [];
        if (results.length) console.log(`  ${studioName} ${yr}: +${results.length}`);
        allRaw.push(...results);
        await sleep(40);
      }
    } catch(e) {
      console.warn(`  Studio pass skipped ${studioName}: ${e.message}`);
    }
  }

  // Dedupe + filter to today onwards
  const seen = new Set();
  allRaw = allRaw.filter(m => {
    if (!m.release_date || seen.has(m.id)) return false;
    seen.add(m.id);
    return m.release_date >= todayStr;
  });
  console.log(`\nRaw after dedupe: ${allRaw.length}`);

  // Fetch details + apply selection criteria in batches
  const movies = [];
  const batchSize = 5;
  const STREAMING_COMPANIES = [
    'netflix','amazon','apple','disney+','hulu','peacock',
    'paramount+','hbo','max','mubi','shudder','tubi'
  ];

  for (let i = 0; i < allRaw.length; i += batchSize) {
    const batch = allRaw.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async m => {
      try {
        const [details, credits, relDates] = await Promise.all([
          tmdb('/movie/' + m.id + '?append_to_response=release_dates'),
          tmdb('/movie/' + m.id + '/credits'),
          tmdb('/movie/' + m.id + '/release_dates')
        ]);

        // Noise check first — exclude junk regardless
        if (isNoise(m, details)) return null;

        // Selection criteria check
        if (!meetsSelectionCriteria(m, details, credits)) return null;

        // Director
        const directors = (credits.crew || []).filter(c => c.job === 'Director').map(c => c.name);
        const directorStr = directors.length ? directors.join(', ') : null;

        // Studio
        const companies = details.production_companies || [];
        const studioStr = companies.slice(0, 2).map(c => c.name).join(' / ') || null;
        const prestige = hasWhitelistedStudio(companies);
        const studioLower = (studioStr || '').toLowerCase();
        const isStreamer = STREAMING_COMPANIES.some(s => studioLower.includes(s));

        // Format from release dates
        const caEntry = (relDates.results || []).find(r => r.iso_3166_1 === 'CA')
          || (relDates.results || []).find(r => r.iso_3166_1 === 'US')
          || (relDates.results || [])[0];

        let format = 'theatrical';
        let reRelease = false;
        if (caEntry) {
          const relDatesArr = caEntry.release_dates || [];
          const types = relDatesArr.map(d => d.type);
          reRelease = detectReRelease(relDatesArr);
          if (types.includes(5)) format = 'physical';
          else if (types.includes(4) && isStreamer) format = 'streaming';
          else if (types.includes(4)) format = 'digital';
          else format = 'theatrical';
        }

        return {
          id: m.id,
          title: m.title,
          releaseDate: m.release_date,
          poster: m.poster_path ? 'https://image.tmdb.org/t/p/w92' + m.poster_path : null,
          format,
          reRelease,
          directorStr,
          studioStr,
          prestige,
          imdbId: details.imdb_id || null
        };
      } catch(e) {
        console.warn(`  Details failed for ${m.title}: ${e.message}`);
        return null;
      }
    }));

    const valid = results.filter(Boolean);
    movies.push(...valid);
    console.log(`  Processed ${Math.min(i + batchSize, allRaw.length)}/${allRaw.length} — kept ${movies.length}`);
    await sleep(80);
  }

  movies.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  return movies;
}

(async () => {
  console.log('Starting The Drop fetch...');
  console.log('Date:', new Date().toISOString());
  try {
    const movies = await fetchAllMovies();
    const output = {
      generatedAt: new Date().toISOString(),
      count: movies.length,
      movies
    };
    fs.writeFileSync('movies.json', JSON.stringify(output, null, 2));
    console.log(`\nDone — wrote ${movies.length} movies to movies.json`);
  } catch(e) {
    console.error('Fatal:', e.message);
    process.exit(1);
  }
})();
