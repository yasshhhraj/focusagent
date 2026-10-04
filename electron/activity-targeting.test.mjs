import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { isOwnActivity, markSessionRelated } from "./activity-targeting.mjs";

test("recognizes the Focus Agent process without hiding unrelated Electron apps", () => {
  const ownProcessIds = new Set([1200, 1201]);
  assert.equal(isOwnActivity("electron", 1200, ownProcessIds), true);
  assert.equal(isOwnActivity("electron", 9000, ownProcessIds), false);
  assert.equal(isOwnActivity("unknown", 0, new Set([0])), false);
  assert.equal(isOwnActivity("focus-agent", 9000, ownProcessIds), true);
  assert.equal(isOwnActivity("code", 9000, ownProcessIds), false);
});

test("corrects the displayed session even when the app itself became latest", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE activity_sessions (
      id INTEGER PRIMARY KEY, application TEXT NOT NULL, classification TEXT NOT NULL,
      task_id INTEGER, corrected INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE task_app_links (
      task_id INTEGER NOT NULL, application TEXT NOT NULL, classification TEXT NOT NULL,
      PRIMARY KEY (task_id, application)
    );
    INSERT INTO tasks VALUES (7, 'active');
    INSERT INTO activity_sessions VALUES (41, 'firefox-esr', 'unknown', 7, 0);
    INSERT INTO activity_sessions VALUES (42, 'focus-agent', 'related', 7, 0);
  `);

  assert.deepEqual(markSessionRelated(database, 41, 7), {
    updated: true,
    sessionId: 41,
    application: "firefox-esr",
  });
  assert.deepEqual({ ...database.prepare("SELECT classification, corrected FROM activity_sessions WHERE id = 41").get() }, {
    classification: "related",
    corrected: 1,
  });
  assert.deepEqual({ ...database.prepare("SELECT classification, corrected FROM activity_sessions WHERE id = 42").get() }, {
    classification: "related",
    corrected: 0,
  });
  assert.equal(database.prepare("SELECT application FROM task_app_links WHERE task_id = 7").get().application, "firefox-esr");
});
