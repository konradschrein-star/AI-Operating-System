/**
 * Smoke: pure-function tests of verifySignature + renderTemplate. No DB.
 * Run: npx tsx scripts/smoke-webhook-helpers.ts
 */
import crypto from "node:crypto";
import { verifySignature, renderTemplate } from "../src/db/webhooks.ts";

function main() {
  // HMAC: matching signature → true
  const secret = "test-secret-32-bytes-of-entropy-please";
  const body = JSON.stringify({ id: 42, ref: "refs/heads/main" });
  const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const header = `sha256=${sig}`;
  if (!verifySignature(body, header, secret)) {
    throw new Error("verifySignature should accept a correct signature");
  }

  // Wrong secret → false
  if (verifySignature(body, header, "wrong-secret")) {
    throw new Error("verifySignature should reject a wrong secret");
  }

  // Tampered body → false
  if (verifySignature(body + "x", header, secret)) {
    throw new Error("verifySignature should reject tampered body");
  }

  // Missing / malformed header → false
  if (verifySignature(body, null, secret)) {
    throw new Error("verifySignature should reject null header");
  }
  if (verifySignature(body, "md5=abc", secret)) {
    throw new Error("verifySignature should reject non-sha256 prefix");
  }
  if (verifySignature(body, "sha256=not-hex", secret)) {
    throw new Error("verifySignature should reject non-hex signature");
  }

  // Template render: basic substitution
  const out = renderTemplate(
    "PR {{ body.pr.number }} on {{ body.repo }}: {{ body.action }}",
    { repo: "ai-os", pr: { number: 7 }, action: "opened" },
  );
  if (out !== "PR 7 on ai-os: opened") {
    throw new Error(`unexpected render: ${out}`);
  }

  // Missing path → empty string, no throw
  const out2 = renderTemplate("hello {{ body.absent.deep }} world", {});
  if (out2 !== "hello  world") {
    throw new Error(`missing path should render empty, got: "${out2}"`);
  }

  // Non-string value → JSON-stringified
  const out3 = renderTemplate("payload: {{ body.data }}", {
    data: { x: 1, y: 2 },
  });
  if (out3 !== 'payload: {"x":1,"y":2}') {
    throw new Error(`object value should JSON-stringify, got: ${out3}`);
  }

  console.log("[smoke] webhook helpers passed ✓");
}

main();
