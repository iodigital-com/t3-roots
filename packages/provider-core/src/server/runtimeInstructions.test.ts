import { assert, describe, it } from "@effect/vitest";

import {
  buildRuntimeInstructions,
  PULL_REQUEST_LINKING_INSTRUCTIONS,
} from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("leaves PR linking to a session that already carries it, and keeps runtime identity", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Antigravity",
      model: "gemini-3.8-flash",
      pullRequestLinking: false,
    });

    assert.include(instructions, "through the Antigravity harness, as gemini-3.8-flash.");
    assert.include(
      instructions,
      "Write short paragraphs with blank lines between sections and list items.",
    );
    assert.include(
      instructions,
      "Use inline code sparingly, only for commands, code, or identifiers",
    );
    assert.include(instructions, "not ordinary names or long lists of pills.");
    assert.include(
      instructions,
      "Link only key files the user is likely to open, using absolute paths on separate lines",
    );
    assert.notInclude(instructions, "Link every other file");
    assert.notInclude(instructions, "<pull_request_linking>");
  });

  it("recognizes Antigravity regardless of casing and keeps the PR linking block", () => {
    const instructions = buildRuntimeInstructions({ harness: "  ANTIGRAVITY  " });

    assert.include(instructions, "Write short paragraphs");
    assert.include(instructions, "packing links into sentences.</runtime_info>");
    assert.isTrue(instructions.endsWith(`\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`));
  });

  it("keeps other harnesses' runtime instructions unchanged", () => {
    for (const harness of ["Codex", "Claude", "OpenCode"]) {
      const runtimeInfo = `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness, as Example Model (model slug: example-model) with medium reasoning effort. No need to mention this otherwise. You can embed images, video, and audio using Markdown image syntax with absolute file paths. Link every other file you cite or produce by its absolute path, as in [http.ts:42](/abs/path/http.ts:42), so the user can open it in T3 Code's files viewer.</runtime_info>`;
      const runtime = {
        harness,
        model: "example-model",
        modelName: "Example Model",
        reasoningEffort: "medium",
      };

      assert.strictEqual(
        buildRuntimeInstructions({ ...runtime, pullRequestLinking: false }),
        runtimeInfo,
      );
      assert.strictEqual(
        buildRuntimeInstructions(runtime),
        `${runtimeInfo}\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`,
      );
    }
  });

  it("links PRs the agent creates, takes over, or pushes to, and no others", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.include(instructions, "Link each PR you create, take over, or push to");
    assert.include(instructions, "every stack layer");
    assert.include(instructions, "link_issue");
    assert.include(instructions, "Skip PRs you only read or review");
    assert.include(instructions, "If linking fails, say so.");
    assert.notInclude(instructions, "git log -1");
    assert.notInclude(instructions, "work on");
    // Listing linked PRs as an end-of-work check found nothing to add in audited threads.
    assert.notInclude(instructions, "list_thread_pull_requests");
  });

  it("waits on a PR only with the watch, never with a poll loop", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.notInclude(instructions, "Creation, pending checks, or a merge ask alone is not enough");
    assert.include(instructions, "Links and watches persist across pushes.");
    // The wake message itself carries the do-not-re-watch rule.
    assert.notInclude(instructions, "On a wake");
    assert.include(
      instructions,
      "Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch",
    );
    assert.notInclude(instructions, "merge it now");
    assert.include(instructions, "Otherwise act now or hand back.");
    assert.include(instructions, "then watch and end your turn");
    assert.include(instructions, "never watch, even if the brief says babysit");
    assert.include(
      instructions,
      "After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>.",
    );
    assert.include(
      instructions,
      "For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup.",
    );
    assert.include(instructions, "call unwatch_pull_request");
  });
});
