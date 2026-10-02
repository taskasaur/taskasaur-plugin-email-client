"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import DOMPurify from "dompurify";
import { Send, RefreshCw, Plus, Download, Paperclip } from "lucide-react";
import type { AppRuntime } from "@taskasaur/plugin-host";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import { getSchema } from "@taskasaur/platform/core/catalog";
import type { Value } from "@taskasaur/platform/field-types";
import { FieldInput } from "@taskasaur/ui/fields";
import { RecordTable } from "@taskasaur/ui/record-table";
import { Button } from "@taskasaur/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@taskasaur/ui/primitives/dialog";
import { download } from "@taskasaur/ui/download";
export default function EmailView({ runtime }: { runtime: AppRuntime }) {
  const [tab, setTab] = useState("mail"),
    [message, setMessage] = useState<ResourceRecord | null>(null),
    [draft, setDraft] = useState<ResourceRecord | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [accountId, setAccountId] = useState(""),
    [mailbox, setMailbox] = useState(""),
    [beforeSequence, setBeforeSequence] = useState<number>();
  const accounts =
      useLiveQuery(
        () => runtime.collection("mail_accounts").list(),
        [runtime],
      ) ?? [],
    folders =
      useLiveQuery(() => runtime.collection("mailboxes").list(), [runtime]) ??
      [];
  const store = useMemo(() => {
    const source = runtime.collection("mail");
    return {
      ...source,
      list: async () =>
        (await source.list()).filter(
          (row) =>
            !row.data.provider_deleted &&
            (!accountId || row.data.account_id === accountId) &&
            (!mailbox ||
              (mailbox === "drafts"
                ? ["draft", "queued", "sending", "failed", "unknown"].includes(
                    String(row.data.status),
                  )
                : row.data.mailbox === mailbox)),
        ),
    };
  }, [runtime, accountId, mailbox]);
  async function receive(older = false) {
    setBusy(true);
    try {
      await runtime.synchronize();
      await runtime.api("mail/folders", { id: accountId });
      const result = await runtime.api<{ beforeSequence: number }>(
        "mail/sync",
        {
          id: accountId,
          mailbox: mailbox && mailbox !== "drafts" ? mailbox : "INBOX",
          ...(older && beforeSequence ? { beforeSequence } : {}),
        },
      );
      setBeforeSequence(result.beforeSequence);
      await runtime.synchronize();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function compose(data: Record<string, Value> = {}) {
    try {
      const entry = await runtime.collection("mail").put({
        account_id: accountId || accounts[0]?.id || null,
        mailbox: "Drafts",
        ...data,
        status: "draft",
      });
      setDraft(entry);
    } catch (e) {
      setError(String(e));
    }
  }
  async function change(
    row: ResourceRecord,
    operation: string,
    destination?: string,
  ) {
    try {
      await runtime
        .collection("mail_operations")
        .put({ message_id: row.id, operation, mailbox: destination ?? null });
      void runtime.synchronize().catch((e) => setError(e.message));
    } catch (e) {
      setError(String(e));
    }
  }
  async function open(row: ResourceRecord) {
    if (["draft", "failed"].includes(String(row.data.status))) {
      setDraft(row);
      return;
    }
    setMessage(row);
    if (
      row.data.status === "received" &&
      !row.data.body &&
      runtime.profile.connected &&
      navigator.onLine
    ) {
      try {
        const read = await runtime.api<ResourceRecord>("mail/read", {
          id: row.id,
        });
        await runtime.db.records.put(read);
        setMessage(read);
        await runtime.synchronize();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {["mail", "accounts", "operations"].map((name) => (
          <Button
            key={name}
            variant={tab === name ? "secondary" : "ghost"}
            onClick={() => setTab(name)}
          >
            {name[0].toUpperCase() + name.slice(1)}
          </Button>
        ))}
      </div>
      {!runtime.profile.connected && (
        <div className="notice">
          Drafts are saved on this device. Connect a workspace to receive and
          send mail.
        </div>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {tab === "accounts" ? (
        <RecordTable runtime={runtime} collection="mail_accounts" />
      ) : tab === "operations" ? (
        <RecordTable runtime={runtime} collection="mail_operations" readOnly />
      ) : (
        <RecordTable
          runtime={runtime}
          collection="mail"
          storeOverride={store}
          readOnly
          onOpen={(row) => void open(row)}
          toolbar={
            <>
              <select
                className="core-select w-40"
                aria-label="Mail account"
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  setMailbox("");
                  setBeforeSequence(undefined);
                }}
              >
                <option value="">All accounts</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {String(a.data.name)}
                  </option>
                ))}
              </select>
              <select
                className="core-select w-36"
                aria-label="Mailbox"
                value={mailbox}
                onChange={(e) => {
                  setMailbox(e.target.value);
                  setBeforeSequence(undefined);
                }}
              >
                <option value="">All messages</option>
                <option value="drafts">Drafts and outbox</option>
                {folders
                  .filter((f) => !accountId || f.data.account_id === accountId)
                  .map((f) => (
                    <option key={f.id} value={String(f.data.path)}>
                      {String(f.data.name)}
                    </option>
                  ))}
              </select>
              <Button
                variant="outline"
                disabled={
                  !runtime.profile.connected ||
                  busy ||
                  !accountId ||
                  !navigator.onLine
                }
                onClick={() => void receive()}
              >
                <RefreshCw size={14} />
                Receive
              </Button>
              {Boolean(beforeSequence) && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void receive(true)}
                >
                  Older messages
                </Button>
              )}
              <Button onClick={() => void compose()}>
                <Plus size={14} />
                Compose
              </Button>
            </>
          }
          renderActions={(row) =>
            row.data.status === "received" ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void change(row, row.data.read ? "unread" : "read")
                  }
                >
                  {row.data.read ? "Mark unread" : "Mark read"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void change(
                      row,
                      (row.data.flags as string[])?.includes("\\Flagged")
                        ? "unflag"
                        : "flag",
                    )
                  }
                >
                  {(row.data.flags as string[])?.includes("\\Flagged")
                    ? "Unstar"
                    : "Star"}
                </Button>
              </>
            ) : null
          }
        />
      )}
      <Dialog
        open={Boolean(message)}
        onOpenChange={(open) => {
          if (!open) setMessage(null);
        }}
      >
        <DialogContent className="max-w-3xl max-h-[85dvh] overflow-auto">
          <DialogHeader>
            <DialogTitle>
              {String(message?.data.subject || "(No subject)")}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {String(message?.data.from ?? "")}
          </p>
          {message && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  void compose({
                    account_id: message.data.account_id,
                    to: String(message.data.from ?? "")
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                    subject: `Re: ${message.data.subject ?? ""}`,
                    body: `\n\n${String(message.data.body ?? "")
                      .split("\n")
                      .map((line) => "> " + line)
                      .join("\n")}`,
                    in_reply_to: message.data.message_id,
                    references: [
                      ...((message.data.references as string[]) ?? []),
                      String(message.data.message_id ?? ""),
                    ].filter(Boolean),
                  });
                  setMessage(null);
                }}
              >
                Reply
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  const address = accounts.find(
                    (a) => a.id === message.data.account_id,
                  )?.data.address;
                  void compose({
                    account_id: message.data.account_id,
                    to: [
                      ...new Set(
                        [
                          ...String(message.data.from ?? "").split(","),
                          ...((message.data.to as string[]) ?? []),
                          ...((message.data.cc as string[]) ?? []),
                        ]
                          .map((s) => s.trim())
                          .filter((s) => s && s !== address),
                      ),
                    ],
                    subject: `Re: ${message.data.subject ?? ""}`,
                    body: `\n\n${message.data.body ?? ""}`,
                    in_reply_to: message.data.message_id,
                  });
                  setMessage(null);
                }}
              >
                Reply all
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  void compose({
                    account_id: message.data.account_id,
                    subject: `Fwd: ${message.data.subject ?? ""}`,
                    body: `\n\nFrom: ${message.data.from ?? ""}\n${message.data.body ?? ""}`,
                  });
                  setMessage(null);
                }}
              >
                Forward
              </Button>
              <select
                aria-label="Move message"
                className="core-select"
                value=""
                onChange={(e) => {
                  void change(message, "move", e.target.value);
                  setMessage(null);
                }}
              >
                <option value="">Move to…</option>
                {folders
                  .filter(
                    (f) =>
                      f.data.account_id === message.data.account_id &&
                      f.data.path !== message.data.mailbox,
                  )
                  .map((f) => (
                    <option key={f.id} value={String(f.data.path)}>
                      {String(f.data.name)}
                    </option>
                  ))}
              </select>
            </div>
          )}
          {message?.data.html ? (
            <iframe
              title="Email content"
              sandbox=""
              className="w-full min-h-96 bg-white rounded"
              srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><body>${DOMPurify.sanitize(String(message.data.html), { FORBID_TAGS: ["form", "script", "iframe", "object", "embed"], FORBID_ATTR: ["srcset"] })}</body>`}
            />
          ) : (
            <pre className="whitespace-pre-wrap font-sans text-sm">
              {String(
                message?.data.body ??
                  "Message content has not been downloaded.",
              )}
            </pre>
          )}
          {Array.isArray(message?.data.attachments) &&
            message.data.attachments.map((value, index) => {
              const attachment = value as Record<string, Value>;
              return (
                <Button
                  key={index}
                  variant="outline"
                  disabled={!attachment.file_id}
                  onClick={async () => {
                    try {
                      const file = await runtime.fileBytes(
                        String(attachment.file_id),
                      );
                      download(String(attachment.name), file.blob);
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  <Download size={14} />
                  {String(attachment.name)}
                  {!attachment.file_id
                    ? " · Enable attachments and download this message again"
                    : ""}
                </Button>
              );
            })}
        </DialogContent>
      </Dialog>
      {draft && (
        <Compose
          key={draft.id}
          runtime={runtime}
          record={draft}
          onClose={() => setDraft(null)}
        />
      )}
    </div>
  );
}
function Compose({
  runtime,
  record,
  onClose,
}: {
  runtime: AppRuntime;
  record: ResourceRecord;
  onClose: () => void;
}) {
  const [data, setData] = useState(record.data),
    [status, setStatus] = useState("Saved on this device"),
    [error, setError] = useState(""),
    [optional, setOptional] = useState(false),
    [sending, setSending] = useState(false);
  const latest = useRef(data),
    serial = useRef(Promise.resolve()),
    version = useRef(0),
    savedVersion = useRef(0);
  const schema = getSchema("mail"),
    attachmentsEnabled = runtime.registry.states
      .get("email-client")
      ?.features.includes("attachments");
  function update(key: string, value: Value) {
    latest.current = { ...latest.current, [key]: value };
    version.current++;
    setData(latest.current);
    setStatus("Saving…");
  }
  function flush() {
    const target = version.current,
      snapshot = latest.current;
    serial.current = serial.current
      .catch(() => undefined)
      .then(async () => {
        if (savedVersion.current >= target) return;
        await runtime.collection("mail").put(snapshot, record.id);
        savedVersion.current = target;
        setStatus("Saved on this device");
      });
    return serial.current;
  }
  useEffect(() => {
    const timer = setTimeout(
      () => void flush().catch((e) => setError(e.message)),
      600,
    );
    return () => clearTimeout(timer);
  }, [data]);
  async function close() {
    try {
      await flush();
      onClose();
    } catch (e) {
      setError(String(e));
    }
  }
  async function send() {
    setSending(true);
    try {
      await flush();
      if (!Array.isArray(latest.current.to) || !latest.current.to.length)
        throw new Error("Add at least one recipient");
      if (!latest.current.account_id)
        throw new Error("Choose a sending account");
      await runtime.collection("mail").put(
        {
          ...latest.current,
          status: "queued",
          send_operation_id: crypto.randomUUID(),
        },
        record.id,
      );
      onClose();
      void runtime.synchronize().catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }
  const controls = [
    "account_id",
    "to",
    "subject",
    "body",
    ...(optional ? ["cc", "bcc"] : []),
  ];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent className="max-w-3xl max-h-[85dvh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Compose message</DialogTitle>
        </DialogHeader>
        {controls.map((id) => {
          const f = schema.fields.find((f) => f.id === id)!;
          return (
            <label key={id} className="field-row">
              {f.label}
              <FieldInput
                definition={f}
                value={data[id]}
                onChange={(value) => update(id, value)}
              />
            </label>
          );
        })}
        <Button variant="ghost" onClick={() => setOptional(!optional)}>
          {optional ? "Hide Cc and Bcc" : "Add Cc and Bcc"}
        </Button>
        {attachmentsEnabled && (
          <label className="upload-button">
            <Paperclip size={14} />
            Attach file
            <input
              type="file"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  if (file.size > 20 * 1024 * 1024)
                    throw new Error("Attachments must be at most 20 MB");
                  const metadata = await runtime.collection("files").put({
                    name: file.name,
                    media_type: file.type || "application/octet-stream",
                    size: String(file.size),
                  });
                  await runtime.db.saveFile(
                    runtime.principal,
                    metadata.id,
                    file,
                    null,
                  );
                  update("attachments", [
                    ...((latest.current.attachments as Value[]) ?? []),
                    { name: file.name, file_id: metadata.id },
                  ]);
                } catch (error) {
                  setError(String(error));
                }
                e.target.value = "";
              }}
            />
          </label>
        )}
        {Array.isArray(data.attachments) &&
          data.attachments.map((value, index) => {
            const attachment = value as Record<string, Value>;
            return (
              <div key={index} className="flex justify-between text-sm">
                {String(attachment.name)}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    update(
                      "attachments",
                      (data.attachments as Value[]).filter(
                        (_, i) => i !== index,
                      ),
                    )
                  }
                >
                  Remove
                </Button>
              </div>
            );
          })}
        {error && (
          <p role="alert" className="error-banner">
            {error}
          </p>
        )}
        <div className="flex justify-between items-center">
          <span className="text-xs text-muted-foreground">{status}</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void close()}>
              Close draft
            </Button>
            <Button
              disabled={sending || !runtime.profile.connected}
              onClick={() => void send()}
            >
              <Send size={14} />
              {navigator.onLine ? "Queue send" : "Send when connected"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
