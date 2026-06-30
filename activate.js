const nacl = require("tweetnacl");
const axios = require("axios");
const { Keypair } = require("@solana/web3.js");
const fs = require("fs");

// ---- Load wallet ----
const secretKeyPath = `${process.env.USERPROFILE}\\.config\\solana\\id.json`;
const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(secretKeyPath, "utf8")));
const wallet = Keypair.fromSecretKey(secretKey);

// Use a DIFFERENT txSig format — sign a fresh message to prove wallet ownership
const AUTH_URL = "http://txline-dev.txodds.com/auth/guest/start";
const ACTIVATE_URL = "http://txline-dev.txodds.com/api/token/activate";

// Your original txSig
const txSig = "3JfUeNdTnVQv5XwyYy6SSS7LG1z52hktWUnt1WQnpeyWixiWJUD5TW3DCyCgDwwE4v7wFBgyK88yaBAb6xEtUXEK";
const SELECTED_LEAGUES = [];

(async () => {
  try {
    // Get a fresh JWT
    console.log("Getting fresh JWT...");
    const authResponse = await axios.post(AUTH_URL);
    const jwt = authResponse.data.token;
    console.log("✅ JWT:", jwt.substring(0, 40) + "...");

    // Sign with fresh JWT (different message each time since JWT changes)
    const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
    const message = new TextEncoder().encode(messageString);
    const signatureBytes = nacl.sign.detached(message, wallet.secretKey);
    const walletSignature = Buffer.from(signatureBytes).toString("base64");

    console.log("Re-activating with fresh JWT...");
    const activationResponse = await axios.post(
      ACTIVATE_URL,
      { txSig, walletSignature, leagues: SELECTED_LEAGUES },
      {
        headers: { Authorization: `Bearer ${jwt}` },
        responseType: "text"
      }
    );

    const apiToken = activationResponse.data;
    console.log("\n✅ API Token:", apiToken);

    fs.writeFileSync("./api-token.json", JSON.stringify({
      jwt,
      apiToken,
      txSig,
      baseUrl: "http://txline-dev.txodds.com"
    }, null, 2));
    console.log("💾 Saved to api-token.json!");

  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error("\n❌ Error:", errMsg);

    // If already used, the token exists — let's try calling the API directly with just the JWT
    if (typeof errMsg === "string" && errMsg.includes("already been used")) {
      console.log("\n💡 Subscription already active. Trying to access API with JWT only...");
      try {
        const authResponse = await axios.post(AUTH_URL);
        const jwt = authResponse.data.token;

        const testRes = await axios.get(
          "http://txline-dev.txodds.com/api/fixtures",
          { headers: { Authorization: `Bearer ${jwt}` } }
        );
        console.log("API response:", JSON.stringify(testRes.data, null, 2).substring(0, 500));
      } catch (e) {
        console.error("API test error:", e.response?.data || e.message);
      }
    }
  }
})();