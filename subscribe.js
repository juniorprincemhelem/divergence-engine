const anchor = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey, SystemProgram } = require("@solana/web3.js");
const {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const nacl = require("tweetnacl");
const axios = require("axios");
const fs = require("fs");

const secretKeyPath = `${process.env.USERPROFILE}\\.config\\solana\\id.json`;
const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(secretKeyPath, "utf8")));
const wallet = Keypair.fromSecretKey(secretKey);
console.log("Wallet:", wallet.publicKey.toBase58());

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const provider = new anchor.AnchorProvider(
  connection,
  new anchor.Wallet(wallet),
  { commitment: "confirmed" }
);
anchor.setProvider(provider);

const idl = JSON.parse(fs.readFileSync("./idl.json", "utf8"));
const PROGRAM_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const program = new anchor.Program(idl, provider);

const TXLINE_MINT = new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");
const SERVICE_LEVEL_ID = 1;
const DURATION_WEEKS = 4;
const SELECTED_LEAGUES = [];

const AUTH_URL = "http://txline-dev.txodds.com/auth/guest/start";
const ACTIVATE_URL = "http://txline-dev.txodds.com/api/token/activate";

(async () => {
  try {
    const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pricing_matrix")], PROGRAM_ID
    );
    const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_treasury_v2")], PROGRAM_ID
    );
    const tokenTreasuryVault = getAssociatedTokenAddressSync(
      TXLINE_MINT, tokenTreasuryPda, true, TOKEN_2022_PROGRAM_ID
    );
    const userTokenAccount = getAssociatedTokenAddressSync(
      TXLINE_MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID
    );

    // ---- Step 1: Get JWT FIRST before subscribing ----
    console.log("\nStep 1: Getting fresh JWT...");
    const authResponse = await axios.post(AUTH_URL);
    const jwt = authResponse.data.token;
    console.log("✅ JWT obtained");

    // ---- Step 2: New subscribe transaction ----
    console.log("\nStep 2: Sending new subscribe transaction...");
    const txSig = await program.methods
      .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
      .accounts({
        user: wallet.publicKey,
        pricingMatrix: pricingMatrixPda,
        tokenMint: TXLINE_MINT,
        userTokenAccount: userTokenAccount,
        tokenTreasuryVault: tokenTreasuryVault,
        tokenTreasuryPda: tokenTreasuryPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();
    console.log("✅ Subscribed! txSig:", txSig);

    // ---- Step 3: Immediately activate with that txSig + same JWT ----
    console.log("\nStep 3: Activating API token...");
    const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
    const message = new TextEncoder().encode(messageString);
    const signatureBytes = nacl.sign.detached(message, wallet.secretKey);
    const walletSignature = Buffer.from(signatureBytes).toString("base64");

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
    console.log("💾 Saved to api-token.json — we're ready to pull data!");

  } catch (err) {
    console.error("\n❌ Error:", err.response?.data || err.message || err);
  }
})();