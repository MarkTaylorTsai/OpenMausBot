import { describe, expect, it } from "vitest";

import { redactSecretsInText } from "./redact.ts";

const VALUE = "aB3dE5gH7jK9mN1pQ3sT5vW7";
const masked = `«redacted ${VALUE.length} chars»`;

describe("redactSecretsInText passes that run only on text that could hold their match", () => {
  it("leaves text with no credential shape as it is", () => {
    for (const text of [
      "The quick brown fox jumps over the lazy dog, twice: once at noon.",
      "const hotkey = keyboard.keys; // a token of thanks, no secret here",
      "see docs/readme.md and src/index.ts for the password rules",
      "ratio 3:4, time 12:30:00, path C:/Users/me",
    ]) expect(redactSecretsInText(text)).toBe(text);
  });

  it("masks every key prefix, alone and after another one", () => {
    const keys = [
      `sk-ant-${VALUE}`, `sk_live_${VALUE}`, `xai-${VALUE}`, `gsk_${VALUE.repeat(2)}`, `csk-${VALUE.repeat(2)}`, `LLM|1234567|${VALUE}`,
      `hf_${VALUE.repeat(2)}`, `ghp_${VALUE}`, `github_pat_${VALUE}`, `glpat-${VALUE}`, `xoxb-${VALUE}`, `xapp-1-${VALUE}`, "AKIAABCDEFGHIJKLMNOP",
      `AIza${VALUE.repeat(2)}`, `npm_${VALUE}`, `whsec_${VALUE}`, `bak_${VALUE}`, "eyJhbGciOiJ.eyJzdWIiOiIx.c2lnbmF0dXJl",
    ];
    for (const key of keys) expect(redactSecretsInText(`use ${key} here`), key).toBe(`use «redacted ${key.length} chars» here`);
    expect(redactSecretsInText(keys.join(" "))).toBe(keys.map((key) => `«redacted ${key.length} chars»`).join(" "));
  });

  it("masks a secret-named value however the name and separator are written", () => {
    for (const lead of [
      "password=", "PASSWORD: ", "passwd = ", 'api_key="', "apiKey: '", "API-KEY=", "MY_SECRET=", "tokens:", '"token": "', "authorization = ",
      "auth-token=", "access_key:\t", "private-key=", "x_secrets=",
    ]) {
      const quote = /["']$/.exec(lead)?.[0] ?? "";
      expect(redactSecretsInText(`${lead}${VALUE}${quote}`), lead).toBe(`${lead}${masked}${quote}`);
    }
    expect(redactSecretsInText("password: leave blank to keep it")).toBe("password: leave blank to keep it");
  });

  it("masks an assignment to a name that ends in key, whatever the value", () => {
    expect(redactSecretsInText("please set XAI_KEY=abc now")).toBe("please set XAI_KEY=«redacted 3 chars» now");
    expect(redactSecretsInText("brave-key='q1' and done")).toBe("brave-key='«redacted 2 chars»' and done");
    expect(redactSecretsInText("hotkey=ctrl keyboard=us")).toBe("hotkey=ctrl keyboard=us");
  });

  it("masks the password in a URL's userinfo", () => {
    expect(redactSecretsInText("clone https://me:hunter2@example.com/repo.git")).toBe("clone https://me:«redacted 7 chars»@example.com/repo.git");
    expect(redactSecretsInText("mail me:hunter2@example.com")).toBe("mail me:hunter2@example.com");
  });

  it("runs a later pass on what an earlier one left", () => {
    expect(redactSecretsInText(`TOKEN=sk-ant-${VALUE} postgres://app:pw@db/x --password ${VALUE}`))
      .toBe(`TOKEN=«redacted ${VALUE.length + 7} chars» postgres://app:«redacted 2 chars»@db/x --password ${masked}`);
    const once = redactSecretsInText(`api_key=${VALUE} MY_KEY=${VALUE}`);
    expect(redactSecretsInText(once)).toBe(once);
  });
});
