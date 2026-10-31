const OPENF1_BASE = "https://api.openf1.org/v1";
const TOKEN_URL = "https://api.openf1.org/token";

const ALLOWED_ENDPOINTS = new Set([
  "meetings",
  "sessions",
  "drivers",
  "laps",
  "car_data",
  "stints",
  "location",
  "position",
  "intervals",
  "race_control",
  "pit",
  "weather",
  "session_result",
]);

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  const username = process.env.OPENF1_USERNAME;
  const password = process.env.OPENF1_PASSWORD;

  if (!username || !password) {
    return null;
  }

  if (
    cachedToken &&
    Date.now() < cachedTokenExpiresAt
  ) {
    return cachedToken;
  }

  const body = new URLSearchParams({
    username,
    password,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",

    headers: {
      "Content-Type":
        "application/x-www-form-urlencoded",

      Accept: "application/json",
    },

    body,
  });

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `No se pudo autenticar con OpenF1: ${response.status} ${text}`
    );
  }

  const payload = await response.json();

  cachedToken =
    payload.access_token;

  cachedTokenExpiresAt =
    Date.now() +
    50 * 60 * 1000;

  return cachedToken;
}

export default async function handler(
  req,
  res
) {
  if (req.method !== "GET") {
    res.setHeader(
      "Allow",
      "GET"
    );

    return res
      .status(405)
      .json({
        error:
          "Método no permitido",
      });
  }

  try {
    const incomingUrl = new URL(
      req.url,
      "http://localhost"
    );

    const endpoint =
      incomingUrl.searchParams.get(
        "endpoint"
      );

    if (
      !endpoint ||
      !ALLOWED_ENDPOINTS.has(
        endpoint
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            "Endpoint OpenF1 no permitido",
        });
    }

    const target = new URL(
      `${OPENF1_BASE}/${endpoint}`
    );

    incomingUrl.searchParams.forEach(
      (value, key) => {
        if (key !== "endpoint" && key !== "public_only") {
          target.searchParams.append(
            key,
            value
          );
        }
      }
    );

    const token = incomingUrl.searchParams.get("public_only") === "1"
      ? null : await getAccessToken();

    const headers = {
      Accept: "application/json",
    };

    if (token) {
      headers.Authorization =
        `Bearer ${token}`;
    }

    const response =
      await fetch(
        target,
        {
          headers,
        }
      );

    const contentType =
      response.headers.get(
        "content-type"
      ) || "";

    if (!response.ok) {
      const detail =
        contentType.includes(
          "application/json"
        )
          ? await response.json()
          : await response.text();

      return res
        .status(response.status)
        .json({
          error:
            typeof detail ===
            "string"
              ? detail
              : detail?.detail ||
                detail?.message ||
                "OpenF1 rechazó la solicitud",
        });
    }

    const data =
      await response.json();

    const longLivedEndpoints = new Set([
      "drivers",
      "laps",
      "stints",
      "session_result",
    ]);

    res.setHeader(
      "Cache-Control",
      longLivedEndpoints.has(endpoint)
        ? "public, s-maxage=1800, stale-while-revalidate=86400"
        : "public, s-maxage=300, stale-while-revalidate=1800"
    );

    return res
      .status(200)
      .json(data);
  } catch (error) {
    return res
      .status(500)
      .json({
        error:
          error instanceof Error
            ? error.message
            : "Error interno del proxy OpenF1",
      });
  }
}
