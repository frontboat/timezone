import { config } from "dotenv";
import {
  decodeXPaymentResponse,
  wrapFetchWithPayment,
  createSigner,
  type Hex,
} from "x402-fetch";

config();

const privateKey = process.env.PRIVATE_KEY as Hex | string;
const baseURL = process.env.RESOURCE_SERVER_URL as string; // e.g. https://example.com
const endpointPath = process.env.ENDPOINT_PATH as string; // e.g. /weather
const url = `${baseURL}${endpointPath}`; // e.g. https://example.com/weather

if (!baseURL || !privateKey || !endpointPath) {
  console.error("Missing required environment variables");
  process.exit(1);
}

/**
 * Demonstrates paying for a protected resource using x402-fetch.
 *
 * Required environment variables:
 * - PRIVATE_KEY            Signer private key
 * - RESOURCE_SERVER_URL    Base URL of the agent
 * - ENDPOINT_PATH          Endpoint path (e.g. /entrypoints/echo/invoke)
 */
async function main(): Promise<void> {
  // const signer = await createSigner("solana-devnet", privateKey); // uncomment for Solana
  const signer = await createSigner("base", privateKey);
  const maxPaymentBaseUnitsEnv = process.env.MAX_PAYMENT_BASE_UNITS;
  const fetchWithPayment = maxPaymentBaseUnitsEnv
    ? wrapFetchWithPayment(fetch, signer, BigInt(maxPaymentBaseUnitsEnv))
    : wrapFetchWithPayment(fetch, signer);

  const timeZone = process.env.TIME_ZONE ?? "America/Denver";
  const rawBody =
    process.env.REQUEST_BODY ??
    JSON.stringify({
      input: {
        timeZone,
      },
    });

  const response = await fetchWithPayment(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: rawBody,
  });

  console.log(`status: ${response.status}`);

  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  console.log(body);

  const paymentHeader = response.headers.get("x-payment-response");
  if (paymentHeader) {
    const paymentResponse = decodeXPaymentResponse(paymentHeader);
    console.log(paymentResponse);
  } else {
    console.warn("No x-payment-response header present on response.");
  }
}

main().catch((error) => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
