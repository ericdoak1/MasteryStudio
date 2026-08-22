import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";

process.env.NODE_ENV = "test";

test("Command Center endpoint authenticates before processing a send", async () => {
  const { createMasteryServer } = await import("../src/server.js");
  const config = loadConfig({
    OPENAI_API_KEY: "openai-key",
    PUBLIC_BASE_URL: "https://mastery.example.com",
    LINQ_API_TOKEN: "linq-key",
    OUTBOUND_API_KEY: "outbound-key"
  });
  const server = createMasteryServer(config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/linq/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "must not send" })
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  }
});

test("public endpoints reject request bodies larger than 1 MB", async () => {
  const { createMasteryServer } = await import("../src/server.js");
  const config = loadConfig({
    OPENAI_API_KEY: "openai-key",
    PUBLIC_BASE_URL: "https://mastery.example.com",
    LINQ_API_TOKEN: "linq-key",
    OUTBOUND_API_KEY: "outbound-key"
  });
  const server = createMasteryServer(config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/linq/send`, {
      method: "POST",
      headers: {
        authorization: "Bearer outbound-key",
        "content-type": "application/json"
      },
      body: JSON.stringify({ text: "x".repeat(1024 * 1024) })
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "Request body exceeds 1 MB" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  }
});

test("Linq webhook fails closed when verification is not configured", async () => {
  const { createMasteryServer } = await import("../src/server.js");
  const config = loadConfig({
    OPENAI_API_KEY: "openai-key",
    PUBLIC_BASE_URL: "https://mastery.example.com",
    LINQ_API_TOKEN: "linq-key"
  });
  const server = createMasteryServer(config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/linq/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 503);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  }
});
