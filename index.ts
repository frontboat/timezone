import {
  configureAgentKit,
  createAgentApp,
  paymentsFromEnv,
} from "@lucid-dreams/agent-kit";
import { z } from "zod";

const networkOverride = "base";
configureAgentKit({
  payments: { network: networkOverride },
});

const meta = {
  name: "timezone-agent",
  version: "0.2.0",
  description:
    "Returns the current date and time for a supplied IANA timezone using timeapi.io.",
};

const defaultPrice = "$0.01";

const resolvedPayments = paymentsFromEnv({ defaultPrice });
const paymentsConfig = {
  ...resolvedPayments,
  facilitatorUrl:
    resolvedPayments.facilitatorUrl ?? "https://x402.org/facilitator",
  network: resolvedPayments.network ?? networkOverride,
};

const { app, addEntrypoint, config: resolvedConfig } = createAgentApp(meta, {
  payments: paymentsConfig,
  config: { payments: paymentsConfig },
  useConfigPayments: true,
});

const currentTimeInput = z.object({
  timeZone: z
    .string()
    .min(1, "timeZone is required")
    .describe("IANA timezone identifier, e.g. America/Denver."),
});

type TimeApiResponse = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  seconds: number;
  milliSeconds: number;
  dateTime: string;
  date: string | null;
  time: string | null;
  timeZone: string | null;
  dayOfWeek: string | null;
  dstActive: boolean;
};

addEntrypoint({
  key: "current-time",
  description:
    "Fetches the current date and time for the requested timezone via timeapi.io.",
  input: currentTimeInput,
  async handler(ctx) {
    const { timeZone } = ctx.input;

    const requestUrl = new URL("https://timeapi.io/api/time/current/zone");
    requestUrl.searchParams.set("timeZone", timeZone);

    let response: Response;
    try {
      response = await fetch(requestUrl, {
        headers: { accept: "application/json" },
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : JSON.stringify(error);
      throw new Error(`[current-time] network request failed: ${reason}`);
    }

    if (!response.ok) {
      const errorBody = await response
        .text()
        .catch(() => "<unable to read response body>");
      throw new Error(
        `[current-time] timeapi.io responded with ${response.status}: ${errorBody}`,
      );
    }

    const payload = (await response.json()) as TimeApiResponse;

    return {
      output: {
        timeZone: payload.timeZone ?? timeZone,
        dateTime: payload.dateTime,
        date: payload.date,
        time: payload.time,
        components: {
          year: payload.year,
          month: payload.month,
          day: payload.day,
          hour: payload.hour,
          minute: payload.minute,
          seconds: payload.seconds,
          milliSeconds: payload.milliSeconds,
        },
        dayOfWeek: payload.dayOfWeek,
        dstActive: payload.dstActive,
        source: "https://timeapi.io/api/time/current/zone",
      },
    };
  },
});

function resolvePort(candidate: string | undefined, fallback = 3000): number {
  if (!candidate) return fallback;
  const parsed = Number.parseInt(candidate, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

if (import.meta.main) {
  const port = resolvePort(process.env.PORT);
  Bun.serve({ fetch: app.fetch, port });
  console.info(
    `[agent-kit] ready on http://localhost:${port} (defaultPrice=${
      resolvedConfig.payments.defaultPrice ?? "unset"
    })`,
  );
  console.info("[agent-kit] entrypoint registered: current-time (invoke)");
}

export { app };
