// Attempts a parcel write and prints only the HTTP status. Run inside the api container via
// `node -` on stdin so the JSON body never has to survive shell quoting.
const token = process.env.PROBE_TOKEN;

fetch('http://127.0.0.1:3001/api/parcels', {
  method: 'POST',
  // A server that accepts the request and never answers must be reported as a failure, not left
  // hanging the validation suite.
  signal: AbortSignal.timeout(25000),
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    khasraNo: '9/9',
    khataNo: '99',
    district: 'Jaipur',
    tehsil: 'Sanganer',
    village: 'ProbeVillage',
    ownerName: 'Probe Owner',
    mappedAreaHectares: 1.0,
    boundary: [
      { lat: 26.8, lng: 75.7 },
      { lat: 26.9, lng: 75.8 },
      { lat: 26.7, lng: 75.9 },
    ],
  }),
})
  .then(async (r) => {
    const j = await r.json().catch(() => null);
    console.log(`${r.status}|${j?.error?.code || (j?.success ? 'SUCCESS' : '?')}`);
  })
  .catch((e) => console.log(`UNREACHABLE|${e.message}`));
