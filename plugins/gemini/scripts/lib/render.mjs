function statusIcon(ok) {
  return ok ? "OK " : "!! ";
}

export function formatSpend(source) {
  if (!source) {
    return null;
  }
  const parts = [];
  const turns = source.numTurns;
  if (turns != null && Number.isFinite(Number(turns))) {
    const n = Number(turns);
    parts.push(`${n} turn${n === 1 ? "" : "s"}`);
  }
  const cost = source.totalCostUsd;
  if (cost != null && Number.isFinite(Number(cost))) {
    parts.push(`$${Number(cost).toFixed(4)}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

export function renderSetupReport(report) {
  const lines = [];
  lines.push(`Gemini companion setup — ${report.ready ? "ready" : "not ready"}`);
  lines.push(`${statusIcon(report.node.available)}node: ${report.node.detail}`);
  lines.push(
    `${statusIcon(report.agy.available)}agy: ${report.agy.available ? `${report.agy.detail} (${report.agy.binary})` : report.agy.detail}`
  );
  lines.push(
    `${statusIcon(report.auth.loggedIn)}auth: ${report.auth.loggedIn ? `logged in via ${report.auth.method}` : "not logged in"}`
  );
  lines.push(
    `${statusIcon(Boolean(report.sessionId))}claude session id: ${report.sessionId ?? "not exported (session filtering disabled)"}`
  );
  if (report.nextSteps.length > 0) {
    lines.push("");
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderTaskResult(job, run) {
  const lines = [];
  const failed = job.status !== "completed";
  lines.push(`${job.title} ${failed ? "failed" : "finished"} (${job.id}${job.write ? ", write mode" : ", read-only"})`);
  lines.push("");
  if (run.resultText) {
    lines.push(run.resultText.trimEnd());
  } else if (run.error) {
    lines.push(`Error: ${run.error}`);
  } else {
    lines.push("(no output)");
  }
  lines.push("");
  if (job.geminiConversationId) {
    lines.push(`Antigravity conversation: ${job.geminiConversationId}`);
    lines.push(`Continue outside Claude with: agy --conversation ${job.geminiConversationId}`);
  }
  const spend = formatSpend(job);
  if (spend) {
    lines.push(`Spend: ${spend}`);
  }
  lines.push(`Details: /gemini:result ${job.id}`);
  return `${lines.join("\n")}\n`;
}

export function renderQueuedTask(job) {
  return (
    `${job.title} started in the background as ${job.id}.\n` +
    `Track it with /gemini:status ${job.id}; fetch output later with /gemini:result ${job.id}.\n`
  );
}

function jobLine(job) {
  const parts = [
    job.id,
    job.status + (job.elapsed ? ` (${job.elapsed})` : ""),
    job.write ? "write" : "read-only",
    job.summary ?? ""
  ];
  return `- ${parts.filter(Boolean).join(" | ")}`;
}

export function renderStatusReport(snapshot) {
  const lines = [];
  lines.push(`Gemini jobs for ${snapshot.workspaceRoot}`);
  if (!snapshot.sessionFiltered) {
    lines.push("(not filtered by Claude session — session id was not exported)");
  }
  lines.push("");
  lines.push("Running:");
  if (snapshot.running.length === 0) {
    lines.push("- none");
  } else {
    for (const job of snapshot.running) {
      lines.push(jobLine(job));
    }
  }
  lines.push("");
  lines.push("Recent:");
  if (snapshot.recent.length === 0) {
    lines.push("- none");
  } else {
    for (const job of snapshot.recent) {
      lines.push(jobLine(job));
    }
  }
  lines.push("");
  lines.push("Use /gemini:result [job-id] for output, /gemini:cancel [job-id] to stop a running job.");
  return `${lines.join("\n")}\n`;
}

export function renderJobStatusReport(job) {
  const lines = [
    `Job ${job.id} — ${job.status}${job.elapsed ? ` (${job.elapsed})` : ""}`,
    `Title: ${job.title ?? "-"}`,
    `Mode: ${job.write ? "write (--dangerously-skip-permissions)" : "read-only (--mode plan)"}`,
    `Summary: ${job.summary ?? "-"}`,
    `Antigravity conversation: ${job.geminiConversationId ?? "-"}`,
    `Spend: ${formatSpend(job) ?? "-"}`,
    `Created: ${job.createdAt ?? "-"}`,
    `Finished: ${job.finishedAt ?? "-"}`
  ];
  if (job.error) {
    lines.push(`Error: ${job.error}`);
  }
  if (job.status === "completed") {
    lines.push(`Fetch output with /gemini:result ${job.id}.`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderStoredJobResult(job, record) {
  const lines = [];
  lines.push(`Job ${job.id} — ${job.status}`);
  lines.push("");
  const text = record?.resultText ?? job.resultText;
  const error = record?.error ?? job.error;
  if (text) {
    lines.push(String(text).trimEnd());
  } else if (error) {
    lines.push(`Error: ${error}`);
  } else {
    lines.push("(no stored output)");
  }
  lines.push("");
  const conversationId = record?.geminiConversationId ?? job.geminiConversationId;
  if (conversationId) {
    lines.push(`Antigravity conversation: ${conversationId}`);
    lines.push(`Continue outside Claude with: agy --conversation ${conversationId}`);
  }
  const spend = formatSpend(record ?? job);
  if (spend) {
    lines.push(`Spend: ${spend}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderCancelReport(job, kill) {
  const lines = [`Cancelled ${job.id}.`];
  if (kill?.attempted) {
    lines.push(kill.killed ? "Worker process tree terminated." : "Worker process was already gone.");
  }
  if (job.geminiConversationId) {
    lines.push(
      `The Antigravity conversation survives up to its last completed tool call; resume with /gemini:rescue --resume or agy --conversation ${job.geminiConversationId}.`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderResumeCandidate(result) {
  if (result.activeJob) {
    return `A Gemini task is still active in this session: ${result.activeJob.id} (${result.activeJob.status}). Check /gemini:status first.\n`;
  }
  if (result.candidate) {
    return `Resumable Gemini task found: ${result.candidate.id} (${result.candidate.status}).\n`;
  }
  return `No resumable Gemini task found${result.sessionFiltered ? " for this session" : " (not session-filtered)"}.\n`;
}
