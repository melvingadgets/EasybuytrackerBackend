import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// migrate-shadow-person-ids.ts run for real, as a child process, against a throwaway database on the
// local replica set and a stand-in for auth. The promises worth pinning are the ones a careless edit
// would break without any other test noticing: a dry run changes nothing, not even an index; a remote
// database is refused; and a run that couldn't check everyone says so in its exit code.

const SCRIPT_TIMEOUT_MS = 60_000;
const host = process.env.MONGO_RS_HOST ?? "127.0.0.1:27028";

let conn: mongoose.Connection;
let databaseUrl: string;
let server: Server;
let authUrl: string;
let requests: string[] = [];
let auth: { tokenStatus: number; people: Set<string>; failing: Set<string> };

const users = () => conn.collection("users");
const objectId = (id: string) => new mongoose.Types.ObjectId(id);

const newAccount = async (fields: Record<string, unknown> = {}) => {
  const _id = new mongoose.Types.ObjectId();
  await users().insertOne({ _id, fullName: "Someone", email: `${_id}@example.test`, ...fields });
  return String(_id);
};

const runScript = (args: string[], database = databaseUrl) =>
  new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "migrate-shadow-person-ids.ts", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // Both spellings. They're one variable on Windows, and spawn keeps whichever sorts first.
        DATABASE_URL: database,
        Database_url: database,
        AUTH_SERVICE_URL: authUrl,
        SERVICE_CLIENT_ID: "svc-easybuy",
        SERVICE_CLIENT_SECRET: "test-secret",
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });

beforeAll(async () => {
  databaseUrl = `mongodb://${host}/easybuy_shadow_script_${randomUUID().slice(0, 8)}?directConnection=true`;
  conn = await mongoose.createConnection(databaseUrl).asPromise();

  server = createServer((req, res) => {
    const url = String(req.url);
    requests.push(url);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url === "/oauth/token") {
      if (auth.tokenStatus !== 200) return send(auth.tokenStatus, { message: "refused" });
      return send(200, { access_token: "test-token", expires_in: 300 });
    }
    const personId = /^\/api\/v1\/auth\/internal\/v2\/people\/([^/]+)$/.exec(url)?.[1] ?? "";
    if (req.headers.authorization !== "Bearer test-token") return send(401, { message: "unauthorized" });
    if (auth.failing.has(personId)) return send(500, { message: "boom" });
    if (!auth.people.has(personId)) return send(404, { message: "person not found" });
    return send(200, { personId, email: "never-logged@example.test", fullName: "Never Logged" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  authUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await conn.dropDatabase();
  await conn.close();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests = [];
  auth = { tokenStatus: 200, people: new Set(), failing: new Set() };
});

afterEach(async () => {
  await users().drop().catch(() => undefined);
});

describe("migrate-shadow-person-ids", () => {
  it("is a dry run by default: it reports, and the database doesn't change, not even an index", async () => {
    const shadow = await newAccount();
    await newAccount();
    auth.people.add(shadow);
    const before = await users().find({}).sort({ _id: 1 }).toArray();

    const { code, output } = await runScript([]);

    expect(output).toContain("dry run");
    expect(output).toContain("would stamp: 1");
    expect(output).toContain("not a person in auth (left alone): 1");
    expect(output).toContain("before: { accounts: 2, withPerson: 0, withoutPerson: 2 }");
    expect(output).toContain("after: { accounts: 2, withPerson: 0, withoutPerson: 2 }");
    expect(output).toContain("reconciliation: OK");
    expect(code).toBe(0);
    expect(await users().find({}).sort({ _id: 1 }).toArray()).toEqual(before);
    expect((await users().indexes()).map((index) => index.name)).toEqual(["_id_"]);
  }, SCRIPT_TIMEOUT_MS);

  it("doesn't even create the collection when the database name is wrong", async () => {
    const { code, output } = await runScript([]);

    expect(output).toContain("checked 0 account(s)");
    expect(code).toBe(0);
    expect(await conn.db!.listCollections({ name: "users" }).toArray()).toEqual([]);
  }, SCRIPT_TIMEOUT_MS);

  it("--write builds the unique index first, stamps what auth confirms, and reconciles the counts", async () => {
    const shadow = await newAccount();
    const older = await newAccount();
    auth.people.add(shadow);

    const { code, output } = await runScript(["--write"]);

    expect(output).toContain("personId index: built");
    expect(output).toContain("stamped: 1");
    expect(output).toContain("after: { accounts: 2, withPerson: 1, withoutPerson: 1 }");
    expect(output).toContain("reconciliation: OK (1 stamped)");
    expect(code).toBe(0);
    expect((await users().findOne({ _id: objectId(shadow) }))?.personId).toBe(shadow);
    expect((await users().findOne({ _id: objectId(older) }))?.personId).toBeUndefined();
    const index = (await users().indexes()).find((entry) => entry.name === "personId_1");
    expect(index).toMatchObject({ unique: true, partialFilterExpression: { personId: { $type: "string" } } });
  }, SCRIPT_TIMEOUT_MS);

  it("reports a person another account holds, leaves it alone, and logs ids but no contact details", async () => {
    const shadow = await newAccount();
    const holder = await newAccount({ personId: shadow });
    auth.people.add(shadow);

    const { code, output } = await runScript(["--write"]);

    expect(output).toContain("person held by another account (left alone): 1");
    expect(output).toContain(`account ${shadow} is that person's shadow, but account ${holder} holds the personId`);
    expect(output).not.toMatch(/example\.test|Never Logged|test-secret|test-token/);
    expect(code).toBe(0);
    expect((await users().findOne({ _id: objectId(shadow) }))?.personId).toBeUndefined();
  }, SCRIPT_TIMEOUT_MS);

  it("exits 1 when auth couldn't answer for someone, without stamping them", async () => {
    const shadow = await newAccount();
    auth.failing.add(shadow);

    const { code, output } = await runScript(["--write"]);

    expect(output).toContain("lookup failed (left alone): 1");
    expect(output).toContain("auth answered HTTP 500");
    expect(code).toBe(1);
    expect((await users().findOne({ _id: objectId(shadow) }))?.personId).toBeUndefined();
  }, SCRIPT_TIMEOUT_MS);

  it("stops before touching the database when auth refuses its credentials", async () => {
    const shadow = await newAccount();
    auth.people.add(shadow);
    auth.tokenStatus = 401;

    const { code, output } = await runScript(["--write"]);

    expect(output).toContain("token request refused (HTTP 401)");
    expect(output).not.toContain("before:");
    expect(code).toBe(1);
    expect((await users().findOne({ _id: objectId(shadow) }))?.personId).toBeUndefined();
  }, SCRIPT_TIMEOUT_MS);

  it.each([
    "mongodb+srv://user:secret@cluster0.example.mongodb.net/EasybuyTracker",
    "mongodb://ac-example-shard-00-00.example.mongodb.net:27017/EasybuyTracker",
  ])("refuses a database that isn't on this machine, before calling anyone: %s", async (uri) => {
    const { code, output } = await runScript([], uri);

    expect(output).toContain("refusing a database that isn't on this machine");
    expect(output).not.toContain("secret");
    expect(code).toBe(1);
    expect(requests).toEqual([]);
  }, SCRIPT_TIMEOUT_MS);

  it("lets --dry-run win over --write", async () => {
    const shadow = await newAccount();
    auth.people.add(shadow);

    const { code, output } = await runScript(["--write", "--dry-run"]);

    expect(output).toContain("would stamp: 1");
    expect(code).toBe(0);
    expect((await users().findOne({ _id: objectId(shadow) }))?.personId).toBeUndefined();
  }, SCRIPT_TIMEOUT_MS);
});
