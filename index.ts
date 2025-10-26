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

const TIME_API_BASE_URL = "https://timeapi.io";

const dstAmbiguitySchema = z
  .union([z.literal("earlier"), z.literal("later"), z.literal("")])
  .optional()
  .describe(
    "When ambiguous due to DST transitions, choose 'earlier', 'later', or leave blank.",
  );

const timeZoneSchema = z
  .string()
  .min(1, "timeZone is required")
  .describe("IANA timezone identifier, e.g. America/Denver.");

const coordinateSchema = z.object({
  latitude: z
    .number()
    .min(-90, "latitude must be >= -90")
    .max(90, "latitude must be <= 90")
    .describe("Latitude in decimal degrees ranging from -90 to 90."),
  longitude: z
    .number()
    .min(-180, "longitude must be >= -180")
    .max(180, "longitude must be <= 180")
    .describe("Longitude in decimal degrees ranging from -180 to 180."),
});

const ipAddressSchema = z
  .string()
  .regex(
    /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/,
    "ipAddress must be a valid IPv4 address.",
  )
  .describe("IPv4 address, e.g. 237.71.232.203.");

const timeSpanSchema = z
  .string()
  .min(1, "timeSpan is required")
  .describe("Timespan formatted as d:hh:mm:ss or d:hh:mm:ss.fff (d=days).");

const dateTimeSchema = z
  .string()
  .min(1, "dateTime is required")
  .describe("Date/time formatted as yyyy-MM-dd HH:mm:ss[.ffffff].");

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be formatted as yyyy-MM-dd")
  .describe("Date formatted as yyyy-MM-dd.");

const noInputSchema = z.object({}).describe("No input required.");

type HeaderRecord = Record<
  string,
  string | number | boolean | null | undefined | string[]
>;

type HeadersInitNormalized = Headers | Array<[string, string]> | HeaderRecord;

function buildTimeApiUrl(
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): URL {
  const url = new URL(path, TIME_API_BASE_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function mergeHeaders(base: Headers, extra?: HeadersInitNormalized): Headers {
  if (!extra) return base;

  if (extra instanceof Headers) {
    extra.forEach((value, key) => base.set(key, value));
    return base;
  }

  if (Array.isArray(extra)) {
    for (const [key, value] of extra) {
      base.set(key, value);
    }
    return base;
  }

  const entries = Object.entries(extra as HeaderRecord);
  for (const [key, rawValue] of entries) {
    if (rawValue === undefined || rawValue === null) continue;
    if (Array.isArray(rawValue)) {
      base.set(key, rawValue.join(", "));
    } else {
      base.set(key, String(rawValue));
    }
  }

  return base;
}

type TimeApiRequestInit = Omit<RequestInit, "headers"> & {
  headers?: HeadersInitNormalized;
};

async function performTimeApiRequest(
  url: URL,
  init: TimeApiRequestInit = {},
  label = url.pathname,
): Promise<{ response: Response; bodyText: string }> {
  const headers = mergeHeaders(
    new Headers({ accept: "application/json" }),
    init.headers,
  );

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[${label}] network request failed: ${reason}`);
  }

  const bodyText = await response.text();
  return { response, bodyText };
}

function truncateBodyPreview(body: string, limit = 500): string {
  if (body.length <= limit) return body;
  return `${body.slice(0, limit)}…`;
}

async function requestTimeApiJson<T>(
  url: URL,
  init: TimeApiRequestInit = {},
  label = url.pathname,
): Promise<T> {
  const { response, bodyText } = await performTimeApiRequest(url, init, label);

  if (!response.ok) {
    const preview = bodyText
      ? truncateBodyPreview(bodyText)
      : "<empty response body>";
    throw new Error(
      `[${label}] timeapi.io responded with ${response.status}: ${preview}`,
    );
  }

  const trimmedBody = bodyText.trim();
  if (!trimmedBody) {
    throw new Error(
      `[${label}] expected JSON body but received an empty response`,
    );
  }

  try {
    return JSON.parse(trimmedBody) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[${label}] failed to parse JSON: ${reason}. Response body: ${truncateBodyPreview(bodyText)}`,
    );
  }
}

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

type Offset = {
  seconds?: number | null;
  milliseconds?: number | null;
  ticks?: number | null;
  nanoseconds?: number | null;
};

type Duration = {
  days?: number;
  nanosecondOfDay?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  milliseconds?: number;
  subsecondTicks?: number;
  subsecondNanoseconds?: number;
  bclCompatibleTicks?: number;
  totalDays?: number;
  totalHours?: number;
  totalMinutes?: number;
  totalSeconds?: number;
  totalMilliseconds?: number;
  totalTicks?: number;
  totalNanoseconds?: number;
};

type DstInterval = {
  dstName?: string | null;
  dstOffsetToUtc?: Offset | null;
  dstOffsetToStandardTime?: Offset | null;
  dstStart?: string | null;
  dstEnd?: string | null;
  dstDuration?: Duration | null;
};

type TimeZoneData = {
  timeZone?: string | null;
  currentLocalTime?: string;
  currentUtcOffset?: Offset | null;
  standardUtcOffset?: Offset | null;
  hasDayLightSaving?: boolean;
  isDayLightSavingActive?: boolean;
  dstInterval?: DstInterval | null;
};

type ConversionResult = {
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  seconds?: number;
  milliSeconds?: number;
  dateTime?: string;
  date?: string | null;
  time?: string | null;
  timeZone?: string | null;
  dstActive?: boolean;
};

type ConversionResponse = {
  fromTimezone?: string | null;
  fromDateTime?: string;
  toTimeZone?: string | null;
  conversionResult?: ConversionResult | null;
};

type TranslationResponse = {
  dateTime?: string | null;
  languageCode?: string | null;
  friendlyDateTime?: string | null;
  friendlyDate?: string | null;
  friendlyTime?: string | null;
};

type CalculationResult = {
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  seconds?: number;
  milliSeconds?: number;
  dateTime?: string;
  date?: string | null;
  time?: string | null;
  dstActive?: boolean;
};

type CalculationResponse = {
  timeZone?: string | null;
  originalDateTime?: string;
  usedTimeSpan?: string | null;
  calculationResult?: CalculationResult | null;
};

type DayOfTheWeekResult = {
  dayOfWeek: string;
};

function createTimeResponse(
  payload: TimeApiResponse,
  url: URL,
  fallbackTimeZone?: string,
) {
  return {
    timeZone: payload.timeZone ?? fallbackTimeZone ?? null,
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
    source: url.toString(),
  };
}

const entrypointKeys: string[] = [];
const registerEntrypoint = (
  definition: Parameters<typeof addEntrypoint>[0],
) => {
  entrypointKeys.push(definition.key);
  return addEntrypoint(definition);
};

const currentTimeInput = z.object({
  timeZone: timeZoneSchema,
});

registerEntrypoint({
  key: "current-time",
  description:
    "Fetches the current date and time for the requested timezone via timeapi.io.",
  input: currentTimeInput,
  async handler(ctx) {
    const { timeZone } = ctx.input;

    const url = buildTimeApiUrl("/api/time/current/zone", { timeZone });
    const payload = await requestTimeApiJson<TimeApiResponse>(
      url,
      {},
      "current-time",
    );

    return {
      output: createTimeResponse(payload, url, timeZone),
    };
  },
});

registerEntrypoint({
  key: "current-time-by-coordinate",
  description:
    "Fetches the current date and time for the supplied geographic coordinates via timeapi.io.",
  input: coordinateSchema,
  async handler(ctx) {
    const { latitude, longitude } = ctx.input;
    const url = buildTimeApiUrl("/api/time/current/coordinate", {
      latitude,
      longitude,
    });
    const payload = await requestTimeApiJson<TimeApiResponse>(
      url,
      {},
      "current-time-by-coordinate",
    );

    return {
      output: createTimeResponse(payload, url),
    };
  },
});

registerEntrypoint({
  key: "current-time-by-ip",
  description:
    "Fetches the current date and time by looking up the supplied IPv4 address via timeapi.io.",
  input: z.object({ ipAddress: ipAddressSchema }),
  async handler(ctx) {
    const { ipAddress } = ctx.input;
    const url = buildTimeApiUrl("/api/time/current/ip", { ipAddress });
    const payload = await requestTimeApiJson<TimeApiResponse>(
      url,
      {},
      "current-time-by-ip",
    );

    return {
      output: createTimeResponse(payload, url),
    };
  },
});

registerEntrypoint({
  key: "available-timezones",
  description: "Lists all available IANA timezones from timeapi.io.",
  input: noInputSchema,
  async handler() {
    const url = buildTimeApiUrl("/api/timezone/availabletimezones");
    const payload = await requestTimeApiJson<string[]>(
      url,
      {},
      "available-timezones",
    );
    return {
      output: {
        timeZones: payload,
        count: payload.length,
        source: url.toString(),
      },
    };
  },
});

const timeZoneInfoInput = z.object({
  timeZone: timeZoneSchema,
});

registerEntrypoint({
  key: "timezone-info",
  description:
    "Gets detailed timezone information for the supplied IANA timezone name via timeapi.io.",
  input: timeZoneInfoInput,
  async handler(ctx) {
    const { timeZone } = ctx.input;
    const url = buildTimeApiUrl("/api/timezone/zone", { timeZone });
    const payload = await requestTimeApiJson<TimeZoneData>(
      url,
      {},
      "timezone-info",
    );

    return {
      output: {
        ...payload,
        source: url.toString(),
      },
    };
  },
});

registerEntrypoint({
  key: "timezone-info-by-coordinate",
  description:
    "Gets timezone information for the supplied geographic coordinates via timeapi.io.",
  input: coordinateSchema,
  async handler(ctx) {
    const { latitude, longitude } = ctx.input;
    const url = buildTimeApiUrl("/api/timezone/coordinate", {
      latitude,
      longitude,
    });
    const payload = await requestTimeApiJson<TimeZoneData>(
      url,
      {},
      "timezone-info-by-coordinate",
    );

    return {
      output: {
        ...payload,
        source: url.toString(),
      },
    };
  },
});

registerEntrypoint({
  key: "timezone-info-by-ip",
  description:
    "Gets timezone information by looking up the supplied IPv4 address via timeapi.io.",
  input: z.object({ ipAddress: ipAddressSchema }),
  async handler(ctx) {
    const { ipAddress } = ctx.input;
    const url = buildTimeApiUrl("/api/timezone/ip", { ipAddress });
    const payload = await requestTimeApiJson<TimeZoneData>(
      url,
      {},
      "timezone-info-by-ip",
    );

    return {
      output: {
        ...payload,
        source: url.toString(),
      },
    };
  },
});

const convertTimeZoneInput = z.object({
  fromTimeZone: timeZoneSchema.describe(
    "Source IANA timezone identifier, e.g. Europe/Amsterdam.",
  ),
  dateTime: dateTimeSchema,
  toTimeZone: timeZoneSchema.describe(
    "Target IANA timezone identifier, e.g. America/Los_Angeles.",
  ),
  dstAmbiguity: dstAmbiguitySchema,
});

registerEntrypoint({
  key: "convert-timezone",
  description:
    "Converts a date/time from one timezone to another using timeapi.io.",
  input: convertTimeZoneInput,
  async handler(ctx) {
    const { fromTimeZone, dateTime, toTimeZone, dstAmbiguity } = ctx.input;
    const url = buildTimeApiUrl("/api/conversion/converttimezone");
    const payload = await requestTimeApiJson<ConversionResponse>(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromTimeZone,
          dateTime,
          toTimeZone,
          ...(dstAmbiguity
            ? { dstAmbiguity: dstAmbiguity.trim() }
            : undefined),
        }),
      },
      "convert-timezone",
    );

    return {
      output: {
        ...payload,
        source: url.toString(),
      },
    };
  },
});

const translationInput = z.object({
  dateTime: dateTimeSchema,
  languageCode: z
    .string()
    .regex(/^[a-z]{2}$/i, "languageCode must be a two-letter ISO 639-1 code.")
    .describe("Two-letter ISO 639-1 language code, e.g. en."),
});

registerEntrypoint({
  key: "translate-datetime",
  description:
    "Translates a date/time into a friendly localized string using timeapi.io.",
  input: translationInput,
  async handler(ctx) {
    const { dateTime, languageCode } = ctx.input;
    const url = buildTimeApiUrl("/api/conversion/translate");
    const payload = await requestTimeApiJson<TranslationResponse>(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateTime, languageCode }),
      },
      "translate-datetime",
    );

    return {
      output: {
        ...payload,
        source: url.toString(),
      },
    };
  },
});

const dayOfWeekInput = z.object({
  date: dateSchema,
});

registerEntrypoint({
  key: "day-of-week",
  description: "Resolves the supplied date to the day of the week via timeapi.io.",
  input: dayOfWeekInput,
  async handler(ctx) {
    const { date } = ctx.input;
    const url = buildTimeApiUrl(
      `/api/conversion/dayoftheweek/${encodeURIComponent(date)}`,
    );
    const payload = await requestTimeApiJson<DayOfTheWeekResult>(
      url,
      {},
      "day-of-week",
    );

    return {
      output: {
        ...payload,
        source: url.toString(),
      },
    };
  },
});

const dayOfYearInput = z.object({
  date: dateSchema,
});

registerEntrypoint({
  key: "day-of-year",
  description:
    "Calculates the ordinal day of the year for the supplied date via timeapi.io.",
  input: dayOfYearInput,
  async handler(ctx) {
    const { date } = ctx.input;
    const url = buildTimeApiUrl(
      `/api/conversion/dayoftheyear/${encodeURIComponent(date)}`,
    );
    const payload = await requestTimeApiJson<unknown>(
      url,
      {},
      "day-of-year",
    );

    if (typeof payload === "number") {
      return {
        output: {
          dayOfYear: payload,
          source: url.toString(),
        },
      };
    }

    if (
      payload &&
      typeof payload === "object" &&
      "dayOfYear" in payload &&
      typeof (payload as { dayOfYear: unknown }).dayOfYear === "number"
    ) {
      return {
        output: {
          dayOfYear: (payload as { dayOfYear: number }).dayOfYear,
          source: url.toString(),
        },
      };
    }

    return {
      output: {
        data: payload,
        source: url.toString(),
      },
    };
  },
});

const currentCalculationInput = z.object({
  timeZone: timeZoneSchema,
  timeSpan: timeSpanSchema,
});

registerEntrypoint({
  key: "increment-current-time",
  description:
    "Increments the current time in a timezone by a timespan via timeapi.io.",
  input: currentCalculationInput,
  async handler(ctx) {
    const { timeZone, timeSpan } = ctx.input;
    const url = buildTimeApiUrl("/api/calculation/current/increment");
    const payload = await requestTimeApiJson<CalculationResponse>(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeZone, timeSpan }),
      },
      "increment-current-time",
    );

    return {
      output: {
        ...payload,
        source: url.toString(),
      },
    };
  },
});

registerEntrypoint({
  key: "decrement-current-time",
  description:
    "Decrements the current time in a timezone by a timespan via timeapi.io.",
  input: currentCalculationInput,
  async handler(ctx) {
    const { timeZone, timeSpan } = ctx.input;
    const url = buildTimeApiUrl("/api/calculation/current/decrement");
    const payload = await requestTimeApiJson<CalculationResponse>(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeZone, timeSpan }),
      },
      "decrement-current-time",
    );

    return {
      output: {
        ...payload,
        source: url.toString(),
      },
    };
  },
});

const customCalculationInput = z.object({
  timeZone: timeZoneSchema,
  dateTime: dateTimeSchema,
  timeSpan: timeSpanSchema,
  dstAmbiguity: dstAmbiguitySchema,
});

registerEntrypoint({
  key: "increment-custom-time",
  description:
    "Increments a custom date/time in a timezone by a timespan via timeapi.io.",
  input: customCalculationInput,
  async handler(ctx) {
    const { timeZone, dateTime, timeSpan, dstAmbiguity } = ctx.input;
    const url = buildTimeApiUrl("/api/calculation/custom/increment");
    const payload = await requestTimeApiJson<CalculationResponse>(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timeZone,
          dateTime,
          timeSpan,
          ...(dstAmbiguity
            ? { dstAmbiguity: dstAmbiguity.trim() }
            : undefined),
        }),
      },
      "increment-custom-time",
    );

    return {
      output: {
        ...payload,
        source: url.toString(),
      },
    };
  },
});

registerEntrypoint({
  key: "decrement-custom-time",
  description:
    "Decrements a custom date/time in a timezone by a timespan via timeapi.io.",
  input: customCalculationInput,
  async handler(ctx) {
    const { timeZone, dateTime, timeSpan, dstAmbiguity } = ctx.input;
    const url = buildTimeApiUrl("/api/calculation/custom/decrement");
    const payload = await requestTimeApiJson<CalculationResponse>(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timeZone,
          dateTime,
          timeSpan,
          ...(dstAmbiguity
            ? { dstAmbiguity: dstAmbiguity.trim() }
            : undefined),
        }),
      },
      "decrement-custom-time",
    );

    return {
      output: {
        ...payload,
        source: url.toString(),
      },
    };
  },
});

registerEntrypoint({
  key: "health-check",
  description: "Runs the timeapi.io health check endpoint.",
  input: noInputSchema,
  async handler() {
    const url = buildTimeApiUrl("/api/health/check");
    const { response, bodyText } = await performTimeApiRequest(
      url,
      { headers: { accept: "text/plain" } },
      "health-check",
    );

    if (!response.ok) {
      const preview = bodyText
        ? truncateBodyPreview(bodyText)
        : "<empty response body>";
      throw new Error(
        `[health-check] timeapi.io responded with ${response.status}: ${preview}`,
      );
    }

    return {
      output: {
        ok: true,
        status: response.status,
        body: bodyText.trim() || null,
        source: url.toString(),
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
  for (const key of entrypointKeys) {
    console.info(`[agent-kit] entrypoint registered: ${key} (invoke)`);
  }
}

export { app };
