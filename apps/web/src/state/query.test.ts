import { PullRequestOperationError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { formatEnvironmentQueryError } from "./query.ts";

const decodeError = Schema.decodeSync(PullRequestOperationError);
const encodeError = Schema.encodeSync(PullRequestOperationError);

it.each(["get", "list"])(
  "displays MR %s recovery instructions after transport decoding",
  (operation) => {
    const detail =
      "The GitLab access token could not be read from the secret provider. Unlock 1Password, then use Settings → Source control → GitLab → check the access token, and retry.";
    const error = new PullRequestOperationError({ operation, detail });
    const decoded = decodeError(encodeError(error));
    expect(formatEnvironmentQueryError(Cause.fail(decoded))).toContain(detail);
  },
);
