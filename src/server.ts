import { z } from "zod";
import { invariant, CoreError } from "@taskasaur/platform/core/errors";
import type { Value } from "@taskasaur/platform/field-types";
import type { Principal } from "@taskasaur/platform/plugin-sdk";
import {
  Repository,
  CredentialBroker,
  FileService,
  DeviceService,
  JobService,
  routerFor,
} from "@taskasaur/server-host";
import { MailService } from "./mail";

export function createBackend(core: any) {
  return {
    async http(request: Request, route: string, input: any) {
      const { repo, principal } = input,
        path = route,
        url = new URL(request.url),
        workspaceId = principal?.workspaceId;
      const broker = () =>
        new CredentialBroker(repo, process.env.CREDENTIAL_ENCRYPTION_KEY ?? "");
      const services = () => ({ repo });
      if (path.startsWith("mail/")) {
        await repo.requirePlugin(principal, "email-client");
        invariant(
          request.method === "POST",
          "METHOD_NOT_ALLOWED",
          "POST required",
        );
        const { id, mailbox, beforeSequence } = z
          .object({
            id: z.string().uuid(),
            mailbox: z.string().max(1000).optional(),
            beforeSequence: z.number().int().positive().optional(),
          })
          .parse(await request.json());
        const mail = new MailService(repo, broker());
        const action = path.slice(5);
        invariant(
          ["sync", "read", "send", "folders", "applyOperation"].includes(
            action,
          ),
          "NOT_FOUND",
          "Mail action not found",
        );
        return Response.json(
          action === "sync"
            ? await mail.sync(principal, id, mailbox, beforeSequence)
            : await mail[
                action as "read" | "send" | "folders" | "applyOperation"
              ](principal, id),
        );
      }
    },
    async tick({
      repo,
      workspaceId,
    }: {
      repo: Repository;
      workspaceId: string;
    }) {
      const jobs = new JobService(repo);
      const sends = await repo.db.query<{
        id: string;
        owner_id: string;
        workspace_id: string;
        send_operation_id: string;
      }>(
        "SELECT r.id,r.owner_id,r.workspace_id,m.send_operation_id FROM taskasaur.resources r JOIN taskasaur.p_mail m ON m.id=r.id JOIN taskasaur.plugins p ON p.workspace_id=r.workspace_id AND p.id='email-client' AND p.enabled WHERE m.status='queued' AND m.send_operation_id IS NOT NULL AND r.deleted_at IS NULL AND r.workspace_id=$1 LIMIT 50",
        [workspaceId],
      );
      for (const send of sends.rows)
        await jobs.enqueue(
          {
            userId: send.owner_id,
            workspaceId: send.workspace_id,
            pluginId: "email-client",
            permissions: ["email-client.read", "email-client.write"],
          },
          "mail.send",
          { id: send.id },
          { operationId: send.send_operation_id },
        );
      const operations = await repo.db.query<{
        id: string;
        owner_id: string;
        workspace_id: string;
      }>(
        "SELECT r.id,r.owner_id,r.workspace_id FROM taskasaur.resources r JOIN taskasaur.p_mail_operations m ON m.id=r.id JOIN taskasaur.plugins p ON p.workspace_id=r.workspace_id AND p.id='email-client' AND p.enabled WHERE m.status='queued' AND r.deleted_at IS NULL AND r.workspace_id=$1 LIMIT 50",
        [workspaceId],
      );
      for (const op of operations.rows)
        await jobs.enqueue(
          {
            userId: op.owner_id,
            workspaceId: op.workspace_id,
            pluginId: "email-client",
            permissions: ["email-client.read", "email-client.write"],
          },
          "mail.applyOperation",
          { id: op.id },
          { operationId: op.id },
        );
    },
    async activate(context: any) {
      const service = context.services.require("core.server"),
        mail = new MailService(
          service.repo,
          new CredentialBroker(
            service.repo,
            process.env.CREDENTIAL_ENCRYPTION_KEY ?? "",
          ),
        );
      const cleanups = [
        "sync",
        "read",
        "send",
        "folders",
        "applyOperation",
      ].map((action) =>
        context.messages.handle(
          "mail." + action,
          {
            id: "mail_command",
            pluginId: "email-client",
            name: "Mail command",
            version: 1,
            fields: [
              service.field("id", "ID", "uuid", {
                required: true,
                nullable: false,
              }),
              service.field("mailbox", "Mailbox"),
              service.field("before_sequence", "Before sequence", "integer"),
            ],
          },
          (input: any) =>
            action === "sync"
              ? mail.sync(
                  context.principal,
                  input.id,
                  input.mailbox ?? undefined,
                  input.before_sequence ?? undefined,
                )
              : (mail as any)[action](context.principal, input.id),
        ),
      );
      return () => cleanups.forEach((dispose) => dispose());
    },
  };
}
export default {
  async activate(context: any) {
    const core = context.services.require("core.server");
    const backend = createBackend(core) as {
      activate?: (context: any) => Promise<unknown>;
    };
    return backend.activate?.(context);
  },
};

export { MailService } from "./mail";
