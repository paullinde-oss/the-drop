// fetch-movies.js
// Runs via GitHub Action nightly — fetches TMDb data and writes movies.json

const fs = require('fs');

const TOKEN = process.env.TMDB_TOKEN;
if (!TOKEN) { console.error('Missing TMDB_TOKEN env var'); process.exit(1); }

const HEADERS = {
  'Authorization': 'Bearer ' + TOKEN,
  'Content-Type': 'application/json'
};

const PRESTIGE_STUDIOS = [
  // Major Hollywood studios
  'walt disney','warner bros','universal pictures','sony pictures',
  'paramount pictures','amazon mgm','lionsgate','netflix','apple original',
  // Prestige indie & arthouse
  'a24','neon','blumhouse','annapurna','ifc','magnolia','vertical',
  'angel studios','xyz films','legendary','miramax','focus features',
  'searchlight','columbia pictures','tristar','screen gems',
  'working title','skydance','laika','aardman',
  // Legacy & international majors
  'metro-goldwyn-mayer','mgm','castle rock','rko',
  'studiocanal','pathe','gaumont','toho','shochiku',
  // Animation
  'dreamworks','pixar','lucasfilm','marvel studios','dc studios',
  'new line cinema',
  // Indian studios
  'yash raj','viacom18','reliance entertainment','utv','sun pictures',
  'madras talkies','excel entertainment',
  // Catch-all variants
  'disney','warner','universal','paramount','sony','amazon','apple'
];

const STREAMING_COMPANIES = [
  'netflix','amazon','apple','disney','hulu','peacock',
  'paramount+','hbo','max','mubi','shudder','tubi'
];

function isPrestige(companies) {
  if (!companies) return false;
  return companies.some(c => {
    const n = (c.name || '').toLowerCase();
    return PRESTIGE_STUDIOS.some(s => n.includes(s));
  });
}

function studioName(companies) {
  if (!companies || !companies.length) return null;
  // Prefer a known prestige studio name if available
  const prestige = companies.find(c => {
    const n = (c.name || '').toLowerCase();
    return PRESTIGE_STUDIOS.some(s => n.includes(s));
  });
  return prestige ? prestige.name : companies[0].name;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function tmdb(path) {
  const res = await fetch('https://api.themoviedb.org/3' + path, { headers: HEADERS });
  if (!res.ok) throw new Error('TMDb error ' + res.status + ' for ' + path);
  return res.json();
}

async function fetchAllMovies() {
  const today = new Date();
  const fmt = d => d.toISOString().split('T')[0];
  const todayStr = fmt(today);
  const currentYear = today.getFullYear();

  // Build monthly windows — 5 years = 60 months
  const windows = [];
  const cursor = new Date(today.getFullYear(), today.getMonth(), 1);
  for (let i = 0; i < 60; i++) {
    const start = new Date(cursor);
    const end = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    windows.push({ gte: fmt(start), lte: fmt(end) });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  let allRaw = [];

  for (let wi = 0; wi < windows.length; wi++) {
    const { gte, lte } = windows[wi];
    const monthLabel = gte.slice(0, 7);
    let page, totalPages;

    // Query both US and CA regions to catch all releases
    for (const region of ['US', 'CA']) {
      page = 1; totalPages = 1;
      while (page <= totalPages && page <= 25) {
        const params = new URLSearchParams({
          region,
          'primary_release_date.gte': gte,
          'primary_release_date.lte': lte,
          sort_by: 'primary_release_date.asc',
          'with_release_type': '1|2|3|4|5',
          page
        });
        try {
          const data = await tmdb('/discover/movie?' + params);
          totalPages = Math.min(data.total_pages || 1, 50);
          console.log(`  ${monthLabel} [${region}] page ${page}/${totalPages} (${wi+1}/${windows.length})`);
          allRaw.push(...(data.results || []));
        } catch(e) {
          console.warn(`  Skipping ${monthLabel} [${region}] page ${page}: ${e.message}`);
          break;
        }
        page++;
        if (page <= totalPages) await sleep(40);
      }
      await sleep(40);
    }
    await sleep(40);
  }

  // Studio guarantee pass — search by company ID for each major studio
  // This catches films that TMDb didn't return in the regional discover query
  console.log('\nRunning studio guarantee pass...');
  const STUDIO_SEARCH_TERMS = [
    'Marvel Studios','DC Studios','Pixar','DreamWorks Animation','Lucasfilm',
    'Blumhouse Productions','A24','Neon','Annapurna Pictures','Universal Pictures',
    'Warner Bros. Pictures','Walt Disney Pictures','Paramount Pictures',
    'Sony Pictures','Lionsgate','Skydance Media','Legendary Entertainment',
    'New Line Cinema','Focus Features','Searchlight Pictures','Apple Original Films',
    'Amazon MGM Studios','Netflix','Angel Studios','Laika','Aardman Animations'
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

  // Include everything from TMDb — no popularity filter
  // Additionally guarantee every film from our studio whitelist is always included
  // even if it somehow slipped through the discover query
  const filtered = allRaw;

  console.log(`\nFiltered: ${filtered.length} movies from ${allRaw.length} raw`);

  // Fetch details (director, studio, format) in batches
  const movies = [];
  const batchSize = 6;

  for (let i = 0; i < filtered.length; i += batchSize) {
    const batch = filtered.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async m => {
      const pop = m.popularity || 0;
      const votes = m.vote_count || 0;

      let directorStr = null, studioStr = null, format = 'theatrical', prestige = false;

      try {
        // Credits
        const credits = await tmdb(`/movie/${m.id}/credits`);
        const directors = (credits.crew || []).filter(c => c.job === 'Director').map(c => c.name);
        directorStr = directors.length ? directors.join(', ') : null;

        // Details
        const details = await tmdb(`/movie/${m.id}`);
        const companies = details.production_companies || [];
        studioStr = companies.slice(0, 2).map(c => c.name).join(' / ') || null;
        prestige = isPrestige(companies);
        const studioLower = (studioStr || '').toLowerCase();
        const isStreamer = STREAMING_COMPANIES.some(s => studioLower.includes(s));

        // Release dates for format detection
        const relDates = await tmdb(`/movie/${m.id}/release_dates`);
        // Prefer CA release date, fall back to US (most major releases share the same date)
        const caEntry = (relDates.results || []).find(r => r.iso_3166_1 === 'CA') ||
                        (relDates.results || []).find(r => r.iso_3166_1 === 'US') ||
                        (relDates.results || [])[0];
        if (caEntry) {
          const relDatesArr = caEntry.release_dates || [];
          const types = relDatesArr.map(d => d.type);
          // TMDb type 6 = TV, but re-releases are theatrical (type 3) entries
          // where the note field contains "re-release", "anniversary", "remaster" etc.
          const reReleaseKeywords = ['re-release', 're release', 'rerelease', 'anniversary', 'remaster', 'restoration', '4k', 'director', 'special screening', 'limited engagement'];
          const isReRelease = relDatesArr.some(d => {
            const note = (d.note || '').toLowerCase();
            return reReleaseKeywords.some(k => note.includes(k));
          });
          m.reRelease = isReRelease;
          if (types.includes(5)) format = 'physical';
          else if (types.includes(4) && isStreamer) format = 'streaming';
          else if (types.includes(4)) format = 'digital';
          else format = 'theatrical';
        }
      } catch(e) {
        console.warn(`  Details failed for ${m.title}: ${e.message}`);
      }

      return {
        id: m.id,
        title: m.title,
        releaseDate: m.release_date,
        poster: m.poster_path ? 'https://image.tmdb.org/t/p/w92' + m.poster_path : null,
        format,
        directorStr,
        studioStr,
        prestige,
        imdbId: m.imdbId || null,
        reRelease: m.reRelease || false
      };
    }));

    movies.push(...results);
    console.log(`  Details: ${Math.min(i + batchSize, filtered.length)}/${filtered.length}`);
    await sleep(80);
  }

  movies.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  return movies;
}

(async () => {
  console.log('Starting TMDb fetch...');
  console.log('Today:', new Date().toISOString());

  try {
    const movies = await fetchAllMovies();
    const output = {
      generatedAt: new Date().toISOString(),
      count: movies.length,
      movies
    };
    fs.writeFileSync('movies.json', JSON.stringify(output, null, 2));
    console.log(`\nWrote movies.json — ${movies.length} movies`);
  } catch(e) {
    console.error('Fatal error:', e.message);
    process.exit(1);
  }
})();
