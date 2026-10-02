import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { createHash, randomUUID } from "node:crypto";
import type { Repository } from "@taskasaur/server-host";
import type { CredentialBroker } from "@taskasaur/server-host";
import type { Principal, ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import { invariant, CoreError } from "@taskasaur/platform/core/errors";
import { FileService } from "@taskasaur/server-host";
function stableId(value: string) {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export class MailService {
  constructor(
    private repo: Repository,
    private broker: CredentialBroker,
  ) {}
  async sync(
    principal: Principal,
    accountId: string,
    mailbox = "INBOX",
    beforeSequence?: number,
  ) {
    const account = await this.repo.get(principal, accountId);
    invariant(
      account.collection === "mail_accounts",
      "VALIDATION_FAILED",
      "Expected a mail account",
    );
    const host = String(account.data.imap_host),
      port = Number(account.data.imap_port),
      destination = `imaps://${host}:${port}`;
    return this.broker.use(
      principal,
      String(account.data.credential_id),
      "email-client",
      destination,
      "mail.sync",
      async (secret) => {
        const client = new ImapFlow({
          host,
          port,
          secure: true,
          auth: {
            user: secret.username ?? String(account.data.address),
            ...(secret.accessToken
              ? { accessToken: secret.accessToken }
              : { pass: secret.password ?? "" }),
          },
          logger: false,
          connectionTimeout: 15000,
          greetingTimeout: 15000,
          socketTimeout: 30000,
        });
        try {
          await client.connect();
          const lock = await client.getMailboxLock(mailbox);
          let count = 0;
          try {
            const box = client.mailbox;
            invariant(box, "MAILBOX_UNAVAILABLE", "Mailbox is unavailable");
            if (!box.exists) return { count: 0 };
            const end = Math.min(box.exists, beforeSequence ?? box.exists),
              start = Math.max(1, end - 99);
            invariant(
              Number.isInteger(end) && end > 0,
              "VALIDATION_FAILED",
              "Invalid mailbox page",
            );
            for await (const message of client.fetch(`${start}:${end}`, {
              uid: true,
              envelope: true,
              flags: true,
              internalDate: true,
              size: true,
            })) {
              const resourceId = stableId(
                `${accountId}:${mailbox}:${box.uidValidity}:${message.uid}`,
              );
              let existing: ResourceRecord | undefined;
              try {
                existing = await this.repo.get(principal, resourceId);
              } catch (e) {
                if (!(e instanceof CoreError && e.kind === "NOT_FOUND"))
                  throw e;
              }
              const envelope = message.envelope;
              await this.repo.mutate(principal, {
                id: randomUUID(),
                resourceId,
                pluginId: "email-client",
                collection: "mail",
                operation: "put",
                baseRevision: existing?.revision ?? 0,
                createdAt: new Date().toISOString(),
                data: {
                  ...existing?.data,
                  account_id: accountId,
                  mailbox,
                  subject: envelope?.subject ?? "",
                  from:
                    envelope?.from
                      ?.map((v) => v.address)
                      .filter(Boolean)
                      .join(", ") ?? "",
                  to:
                    envelope?.to?.map((v) => v.address ?? "").filter(Boolean) ??
                    [],
                  message_id: envelope?.messageId ?? null,
                  provider_uid: String(message.uid),
                  uid_validity: String(box.uidValidity),
                  received_at: message.internalDate
                    ? new Date(message.internalDate).toISOString()
                    : new Date().toISOString(),
                  status: "received",
                  read: message.flags?.has("\\Seen") ?? false,
                  flags: [...(message.flags ?? [])],
                  provider_deleted: false,
                },
              });
              count++;
            }
          } finally {
            lock.release();
          }
          const end = Math.min(
            client.mailbox ? client.mailbox.exists : 0,
            beforeSequence ?? Infinity,
          );
          return { count, beforeSequence: Math.max(0, end - 100) };
        } finally {
          await client.logout().catch(() => client.close());
        }
      },
    );
  }
  async read(principal: Principal, id: string) {
    const message = await this.repo.get(principal, id);
    invariant(
      message.collection === "mail",
      "VALIDATION_FAILED",
      "Expected mail",
    );
    const account = await this.repo.get(
      principal,
      String(message.data.account_id),
    );
    const host = String(account.data.imap_host),
      port = Number(account.data.imap_port);
    return this.broker.use(
      principal,
      String(account.data.credential_id),
      "email-client",
      `imaps://${host}:${port}`,
      "mail.read",
      async (secret) => {
        const client = new ImapFlow({
          host,
          port,
          secure: true,
          auth: {
            user: secret.username ?? String(account.data.address),
            ...(secret.accessToken
              ? { accessToken: secret.accessToken }
              : { pass: secret.password ?? "" }),
          },
          logger: false,
          connectionTimeout: 15000,
          greetingTimeout: 15000,
          socketTimeout: 30000,
        });
        try {
          await client.connect();
          const lock = await client.getMailboxLock(
            String(message.data.mailbox),
          );
          try {
            invariant(
              client.mailbox &&
                String(client.mailbox.uidValidity) ===
                  message.data.uid_validity,
              "MAILBOX_CHANGED",
              "Mailbox identity changed; synchronize again",
            );
            const fetched = await client.fetchOne(
              String(message.data.provider_uid),
              { source: { start: 0, maxLength: 20 * 1024 * 1024 }, size: true },
              { uid: true },
            );
            invariant(
              fetched &&
                fetched.source &&
                (fetched.size ?? 0) <= 20 * 1024 * 1024,
              "MESSAGE_TOO_LARGE",
              "Message is missing or exceeds 20 MB",
            );
            const parsed = await simpleParser(fetched.source);
            const attachments = [];
            const enabled = await this.repo.featureEnabled(
              principal,
              "email-client",
              "attachments",
            );
            for (const [index, attachment] of parsed.attachments.entries()) {
              const fileId = stableId(`${id}:${index}:${attachment.checksum}`);
              if (enabled) {
                let file: ResourceRecord | undefined;
                try {
                  file = await this.repo.get(principal, fileId);
                } catch (error) {
                  if (!(
                    error instanceof CoreError && error.kind === "NOT_FOUND"
                  ))
                    throw error;
                }
                if (!file)
                  file = await this.repo.mutate(principal, {
                    id: randomUUID(),
                    resourceId: fileId,
                    pluginId: "files",
                    collection: "files",
                    operation: "put",
                    baseRevision: 0,
                    createdAt: new Date().toISOString(),
                    data: {
                      name: attachment.filename ?? "attachment",
                      media_type: attachment.contentType,
                      size: String(attachment.size),
                    },
                  });
                if (!file.data.version_id)
                  await new FileService(this.repo).upload(
                    principal,
                    fileId,
                    attachment.content,
                    attachment.contentType,
                    null,
                    stableId(fileId + ":content"),
                  );
              }
              attachments.push({
                name: attachment.filename ?? "attachment",
                media_type: attachment.contentType,
                size: String(attachment.size),
                file_id: enabled ? fileId : null,
              });
            }
            const result = await this.repo.mutate(principal, {
              id: randomUUID(),
              resourceId: id,
              pluginId: "email-client",
              collection: "mail",
              operation: "put",
              baseRevision: message.revision,
              createdAt: new Date().toISOString(),
              data: {
                ...message.data,
                body: parsed.text ?? "",
                html: parsed.html || null,
                read: true,
                attachments,
                in_reply_to: parsed.inReplyTo ?? null,
                references:
                  typeof parsed.references === "string"
                    ? [parsed.references]
                    : (parsed.references ?? []),
              },
            });
            await client.messageFlagsAdd(
              String(message.data.provider_uid),
              ["\\Seen"],
              { uid: true },
            );
            return result;
          } finally {
            lock.release();
          }
        } finally {
          await client.logout().catch(() => client.close());
        }
      },
    );
  }
  async send(principal: Principal, id: string) {
    const message = await this.repo.get(principal, id);
    if (message.collection === "mail" && message.data.status === "sent")
      return message;
    invariant(
      message.collection === "mail" &&
        ["draft", "queued", "failed"].includes(String(message.data.status)),
      "INVALID_MAIL_STATE",
      "This message cannot be sent again without reconciliation",
    );
    invariant(
      Array.isArray(message.data.to) && message.data.to.length > 0,
      "VALIDATION_FAILED",
      "At least one recipient is required",
    );
    const account = await this.repo.get(
      principal,
      String(message.data.account_id),
    );
    const host = String(account.data.smtp_host),
      port = Number(account.data.smtp_port);
    const messageId = String(
      message.data.message_id || `<${message.id}@taskasaur.local>`,
    );
    const attachments: Array<{
      filename: string;
      content: Buffer;
      contentType: string;
    }> = [];
    if (
      Array.isArray(message.data.attachments) &&
      message.data.attachments.length
    ) {
      invariant(
        await this.repo.featureEnabled(
          principal,
          "email-client",
          "attachments",
        ),
        "FEATURE_DISABLED",
        "Enable mail attachments before sending attachments",
      );
      let total = 0;
      for (const value of message.data.attachments) {
        invariant(
          value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            typeof value.file_id === "string",
          "VALIDATION_FAILED",
          "Attachment needs a core file reference",
        );
        const file = await this.repo.get(principal, value.file_id);
        total += Number(file.data.size);
        invariant(
          total <= 20 * 1024 * 1024,
          "PAYLOAD_TOO_LARGE",
          "Attachments exceed 20 MB",
        );
        attachments.push({
          filename: String(file.data.name),
          content: Buffer.from(
            await (
              await new FileService(this.repo).download(principal, file.id)
            ).arrayBuffer(),
          ),
          contentType: String(file.data.media_type),
        });
      }
    }
    let current = await this.repo.mutate(principal, {
      id: randomUUID(),
      resourceId: id,
      pluginId: "email-client",
      collection: "mail",
      operation: "put",
      baseRevision: message.revision,
      createdAt: new Date().toISOString(),
      data: { ...message.data, status: "sending", message_id: messageId },
    });
    let smtpAccepted = false;
    try {
      await this.broker.use(
        principal,
        String(account.data.credential_id),
        "email-client",
        `smtps://${host}:${port}`,
        "mail.send",
        async (secret) => {
          const transporter = nodemailer.createTransport({
            host,
            port,
            secure: account.data.smtp_security !== "starttls",
            requireTLS: account.data.smtp_security === "starttls",
            auth: secret.accessToken
              ? {
                  type: "OAuth2",
                  user: secret.username ?? String(account.data.address),
                  accessToken: secret.accessToken,
                }
              : {
                  user: secret.username ?? String(account.data.address),
                  pass: secret.password ?? "",
                },
            connectionTimeout: 15000,
            socketTimeout: 30000,
          });
          try {
            const result = await transporter.sendMail({
              from: String(account.data.address),
              to: (message.data.to as string[]).join(", "),
              cc: ((message.data.cc as string[]) ?? []).join(", "),
              bcc: ((message.data.bcc as string[]) ?? []).join(", "),
              subject: String(message.data.subject ?? ""),
              text: String(message.data.body ?? ""),
              messageId,
              inReplyTo: message.data.in_reply_to
                ? String(message.data.in_reply_to)
                : undefined,
              references: message.data.references as string[] | undefined,
              attachments,
            });
            // Once DATA has been accepted, a later broker/database failure must
            // never turn this message into an automatically retryable send.
            smtpAccepted = true;
            return result;
          } finally {
            transporter.close();
          }
        },
      );
      current = await this.repo.mutate(principal, {
        id: randomUUID(),
        resourceId: id,
        pluginId: "email-client",
        collection: "mail",
        operation: "put",
        baseRevision: current.revision,
        createdAt: new Date().toISOString(),
        data: { ...current.data, status: "sent" },
      });
      return current;
    } catch (error) {
      const failure = error as {
        code?: string;
        command?: string;
        responseCode?: number;
      };
      const rejected =
        failure.responseCode !== undefined && failure.responseCode >= 400;
      const beforeData = [
        "CONN",
        "EHLO",
        "HELO",
        "STARTTLS",
        "AUTH",
        "MAIL FROM",
        "RCPT TO",
      ].some((command) => failure.command?.startsWith(command));
      const knownFailure =
        !smtpAccepted &&
        (rejected ||
          beforeData ||
          ["EAUTH", "EDNS", "ECONNECTION"].includes(failure.code ?? "") ||
          error instanceof CoreError);
      await this.repo.mutate(principal, {
        id: randomUUID(),
        resourceId: id,
        pluginId: "email-client",
        collection: "mail",
        operation: "put",
        baseRevision: current.revision,
        createdAt: new Date().toISOString(),
        data: { ...current.data, status: knownFailure ? "failed" : "unknown" },
      });
      throw new CoreError(
        knownFailure ? "SMTP_REJECTED" : "SMTP_OUTCOME_UNKNOWN",
        knownFailure
          ? "Mail server rejected delivery. Check the account configuration before retrying."
          : "Delivery could not be confirmed. Check Sent before retrying.",
        {
          stage: failure.command?.split(" ")[0],
          code: failure.code,
          responseCode: failure.responseCode,
        },
      );
    }
  }
  private async withImap<T>(
    principal: Principal,
    accountId: string,
    action: string,
    operation: (client: ImapFlow) => Promise<T>,
  ) {
    const account = await this.repo.get(principal, accountId);
    invariant(
      account.collection === "mail_accounts",
      "VALIDATION_FAILED",
      "Expected a mail account",
    );
    const host = String(account.data.imap_host),
      port = Number(account.data.imap_port);
    return this.broker.use(
      principal,
      String(account.data.credential_id),
      "email-client",
      `imaps://${host}:${port}`,
      action,
      async (secret) => {
        const client = new ImapFlow({
          host,
          port,
          secure: true,
          auth: {
            user: secret.username ?? String(account.data.address),
            ...(secret.accessToken
              ? { accessToken: secret.accessToken }
              : { pass: secret.password ?? "" }),
          },
          logger: false,
          connectionTimeout: 15000,
          greetingTimeout: 15000,
          socketTimeout: 30000,
        });
        try {
          await client.connect();
          return await operation(client);
        } finally {
          await client.logout().catch(() => client.close());
        }
      },
    );
  }
  async folders(principal: Principal, accountId: string) {
    return this.withImap(
      principal,
      accountId,
      "mail.folders",
      async (client) => {
        const folders = await client.list(),
          records: ResourceRecord[] = [];
        for (const folder of folders) {
          if (folder.flags.has("\\Noselect")) continue;
          const id = stableId(`${accountId}:mailbox:${folder.path}`);
          let existing: ResourceRecord | undefined;
          try {
            existing = await this.repo.get(principal, id);
          } catch (error) {
            if (!(error instanceof CoreError && error.kind === "NOT_FOUND"))
              throw error;
          }
          records.push(
            await this.repo.mutate(principal, {
              id: randomUUID(),
              resourceId: id,
              pluginId: "email-client",
              collection: "mailboxes",
              operation: "put",
              baseRevision: existing?.revision ?? 0,
              createdAt: new Date().toISOString(),
              data: {
                account_id: accountId,
                name: folder.name,
                path: folder.path,
                special_use: folder.specialUse ?? null,
              },
            }),
          );
        }
        return records;
      },
    );
  }
  async applyOperation(principal: Principal, id: string) {
    const operation = await this.repo.get(principal, id);
    invariant(
      operation.collection === "mail_operations",
      "VALIDATION_FAILED",
      "Expected a mailbox operation",
    );
    if (operation.data.status === "completed") return operation;
    const message = await this.repo.get(
      principal,
      String(operation.data.message_id),
    );
    await this.withImap(
      principal,
      String(message.data.account_id),
      "mail.change",
      async (client) => {
        const lock = await client.getMailboxLock(String(message.data.mailbox));
        try {
          invariant(
            client.mailbox &&
              String(client.mailbox.uidValidity) === message.data.uid_validity,
            "MAILBOX_CHANGED",
            "Mailbox identity changed; synchronize again",
          );
          const uid = String(message.data.provider_uid),
            kind = String(operation.data.operation),
            flags = new Set((message.data.flags as string[]) ?? []);
          let changed = { ...message.data };
          if (kind === "move") {
            invariant(
              operation.data.mailbox,
              "VALIDATION_FAILED",
              "Choose a destination mailbox",
            );
            const result = await client.messageMove(
              uid,
              String(operation.data.mailbox),
              { uid: true },
            );
            invariant(result, "MAIL_MOVE_FAILED", "Message could not be moved");
            changed = { ...changed, provider_deleted: true };
          } else {
            const flag = ["read", "unread"].includes(kind)
                ? "\\Seen"
                : "\\Flagged",
              add = ["read", "flag"].includes(kind);
            if (add) {
              await client.messageFlagsAdd(uid, [flag], { uid: true });
              flags.add(flag);
            } else {
              await client.messageFlagsRemove(uid, [flag], { uid: true });
              flags.delete(flag);
            }
            changed = {
              ...changed,
              flags: [...flags],
              read: flags.has("\\Seen"),
            };
          }
          await this.repo.mutate(principal, {
            id: randomUUID(),
            resourceId: message.id,
            pluginId: "email-client",
            collection: "mail",
            operation: "put",
            baseRevision: message.revision,
            createdAt: new Date().toISOString(),
            data: changed,
          });
        } finally {
          lock.release();
        }
      },
    );
    return this.repo.mutate(principal, {
      id: randomUUID(),
      resourceId: id,
      pluginId: "email-client",
      collection: "mail_operations",
      operation: "put",
      baseRevision: operation.revision,
      createdAt: new Date().toISOString(),
      data: { ...operation.data, status: "completed" },
    });
  }
}
