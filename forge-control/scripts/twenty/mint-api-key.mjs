// Mint an API key JWT for Twenty by direct DB insert + HS256 sign.
// Rationale: no admin API for keys; Settings UI is one path, this is the other.
// Verified against jwt-wrapper.service.js: legacy HS256 with secret =
// sha256(APP_SECRET + workspaceId + 'API_KEY') is a supported verify path.
import { execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";

const APP_SECRET = process.env.TWENTY_APP_SECRET;
const WORKSPACE_ID = process.env.TWENTY_WORKSPACE_ID;
const ROLE_ID = process.env.TWENTY_ROLE_ID;
const APP_ID = process.env.TWENTY_APP_ID;
const KEY_NAME = process.env.TWENTY_KEY_NAME || "ai-os-importer";
if (!APP_SECRET || !WORKSPACE_ID || !ROLE_ID || !APP_ID) {
  throw new Error("need TWENTY_APP_SECRET, TWENTY_WORKSPACE_ID, TWENTY_ROLE_ID, TWENTY_APP_ID");
}

const apiKeyId = randomUUID();
const universalId = randomUUID();
const expiresAt = new Date(Date.now() + 100 * 365 * 86400 * 1000).toISOString();

const insertSql = `
BEGIN;
INSERT INTO core."apiKey" (id, name, "expiresAt", "workspaceId")
  VALUES ('${apiKeyId}', '${KEY_NAME}', '${expiresAt}', '${WORKSPACE_ID}');
INSERT INTO core."roleTarget" (id, "workspaceId", "roleId", "apiKeyId", "universalIdentifier", "applicationId")
  VALUES ('${randomUUID()}', '${WORKSPACE_ID}', '${ROLE_ID}', '${apiKeyId}', '${universalId}', '${APP_ID}');
COMMIT;
`;
execSync(
  `ssh -i /root/.ssh/vps2_mgmt -o StrictHostKeyChecking=no root@167.233.145.218 "docker exec -i twenty-db-1 psql -U twenty -d default -v ON_ERROR_STOP=1"`,
  { input: insertSql, stdio: ["pipe", "inherit", "inherit"] },
);

// Redis cache purge — the metadata-cache trap costs an hour if skipped.
execSync(
  `ssh -i /root/.ssh/vps2_mgmt -o StrictHostKeyChecking=no root@167.233.145.218 "docker exec twenty-redis-1 sh -c \\"redis-cli --scan --pattern 'engine:workspace:*' | xargs -r redis-cli DEL\\""`,
  { stdio: "inherit" },
);

const secret = createHash("sha256")
  .update(`${APP_SECRET}${WORKSPACE_ID}API_KEY`)
  .digest("hex");
const token = jwt.sign(
  { sub: WORKSPACE_ID, workspaceId: WORKSPACE_ID, type: "API_KEY" },
  secret,
  { algorithm: "HS256", jwtid: apiKeyId, expiresIn: "100y" },
);
console.log(JSON.stringify({ apiKeyId, token }));
