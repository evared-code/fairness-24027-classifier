// Creates the key pair for encoded requests.
//
//   node proxy/keygen.mjs > proxy/private-key.json
//
// Keep private-key.json secret (it is in .gitignore). Give it to the proxy as the PRIVATE_KEY_JWK secret:
//   Vercel:  Project → Settings → Environment Variables → PRIVATE_KEY_JWK (paste the file's content, mark Sensitive)
//   Local:   npm start  (dev-server.mjs reads proxy/private-key.json if it exists)
// The browser tool fetches the matching public key from the proxy's /key address automatically.

const { privateKey } = await crypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["encrypt", "decrypt"]
);
const jwk = await crypto.subtle.exportKey("jwk", privateKey);
process.stdout.write(JSON.stringify(jwk) + "\n");
process.stderr.write("Private key written to standard output. Keep it secret.\n");
