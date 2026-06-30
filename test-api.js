const axios = require("axios");
const fs = require("fs");

const { jwt, apiToken, baseUrl } = JSON.parse(fs.readFileSync("./api-token.json", "utf8"));

// Both headers are required on every call
const headers = {
  Authorization: `Bearer ${jwt}`,
  "X-Api-Token": apiToken
};

(async () => {
  try {
    // Get fixtures snapshot (upcoming + today's matches)
    console.log("=== FETCHING FIXTURES SNAPSHOT ===");
    const fixturesRes = await axios.get(`${baseUrl}/api/fixtures/snapshot`, { headers });
    const fixtures = fixturesRes.data;

    console.log(`Found ${fixtures.length} fixtures\n`);

    // Show first 10 in a readable format
    fixtures.slice(0, 10).forEach(f => {
      const kickoff = new Date(f.StartTime * 1000).toISOString();
      console.log(`[${f.FixtureId}] ${f.Participant1} vs ${f.Participant2}`);
      console.log(`  Competition : ${f.Competition}`);
      console.log(`  Kickoff     : ${kickoff}`);
      console.log();
    });

    // Save full list for reference
    fs.writeFileSync("./fixtures.json", JSON.stringify(fixtures, null, 2));
    console.log(`💾 All ${fixtures.length} fixtures saved to fixtures.json`);

  } catch (err) {
    console.error("Error:", err.response?.status, err.response?.data || err.message);
  }
})();