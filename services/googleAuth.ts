import { google } from "googleapis";

import { getGooglePrivateKey, requireEnv } from "@/lib/env";

export function createGoogleAuth(scopes: string[]) {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: requireEnv("GOOGLE_CLIENT_EMAIL"),
      private_key: getGooglePrivateKey()
    },
    scopes
  });
}
