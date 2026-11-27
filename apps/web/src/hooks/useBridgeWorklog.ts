import {
  AuthOrchestrationOperateScope,
  EnvironmentRequestInvalidError,
  type LocalApi,
  type ScopedThreadRef,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";

import { openBridgeWorklog, reserveBridgeDestination } from "../lib/bridgeWorklog";
import { orchestrationEnvironment } from "../state/orchestration";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

const isEnvironmentRequestInvalidError = Schema.is(EnvironmentRequestInvalidError);

export function useBridgeWorklog() {
  const loadTranscript = useAtomCommand(orchestrationEnvironment.threadTranscript, {
    reportFailure: false,
  });
  return (input: {
    api: LocalApi;
    threadRef: ScopedThreadRef;
    title: string;
    links: ReadonlyArray<ThreadIssueLink> | undefined;
    position: { x: number; y: number };
  }) =>
    openBridgeWorklog({
      reserve: () => reserveBridgeDestination(window, (url) => input.api.shell.openExternal(url)),
      load: async () => {
        const result = await loadTranscript({
          environmentId: input.threadRef.environmentId,
          input: { threadId: input.threadRef.threadId },
        });
        if (result._tag !== "Success") {
          const error = squashAtomCommandFailure(result);
          if (
            isEnvironmentRequestInvalidError(error) &&
            error.reason === "thread_transcript_too_large"
          ) {
            return { items: [] };
          }
          throw error;
        }
        return result.value;
      },
      choose: async (issues) => {
        const selected = await input.api.contextMenu.show(
          issues.map((issue, index) => ({
            id: String(index),
            label: issue.key,
            detail: new URL(issue.url).host,
          })),
          input.position,
        );
        return selected === null ? null : (issues[Number(selected)] ?? null);
      },
      canProceed: () =>
        readEnvironmentScope(input.threadRef.environmentId, AuthOrchestrationOperateScope),
      links: input.links,
      title: input.title,
      now: () => new Date(),
    });
}
