const axios = require("axios");
const fs = require("fs");

const { jwt, apiToken, baseUrl } = JSON.parse(fs.readFileSync("./api-token.json", "utf8"));
const headers = {
  Authorization: `Bearer ${jwt}`,
  "X-Api-Token": apiToken
};

const fixtures = JSON.parse(fs.readFileSync("./fixtures.json", "utf8"));

(async () => {
  for (const fixture of fixtures) {
    const id = fixture.FixtureId;
    try {
      console.log(`\nChecking [${id}] ${fixture.Participant1} vs ${fixture.Participant2}...`);
      
      const res = await axios.get(`${baseUrl}/api/odds/snapshot/${id}`, { headers });
      
      if (res.data && res.data.length > 0) {
        console.log(`✅ HAS ODDS DATA (${res.data.length} entries)`);
        console.log(JSON.stringify(res.data[0], null, 2));
        break; // Found one with data, stop here
      } else {
        console.log(`  ⏳ Empty odds (match not live yet)`);
      }
    } catch (err) {
      console.log(`  ❌ ${err.response?.status}: ${err.response?.data || err.message}`);
    }
  }

  // Also check scores endpoint structure
  console.log("\n\n=== CHECKING SCORES ENDPOINT ===");
  try {
    const id = fixtures[0].FixtureId;
    const res = await axios.get(`${baseUrl}/api/scores/snapshot/${id}`, { headers });
    console.log("Scores data:", JSON.stringify(res.data, null, 2).substring(0, 1000));
  } catch (err) {
    console.log(`Scores error: ${err.response?.status}: ${err.response?.data || err.message}`);
  }
})();