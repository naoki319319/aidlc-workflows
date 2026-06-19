// shared-credential-scrubber.test.ts — 1:1 mirror of the Python test suite.
//
// Source of truth (read-only worktree):
//   .claude/worktrees/v2-inspect/evaluator/packages/shared/tests/test_credential_scrubber.py
//
// Each Python `def test_*` → one TS `test(...)`. Faithful inputs, faithful
// assertions. Two describe blocks mirror the two Python TestCase classes.

import { describe, expect, test } from "bun:test";
import { scrubCredentials, scrubDictValues } from "./shared-credential-scrubber";

// class TestScrubCredentials — test_credential_scrubber.py:9-97
describe("TestScrubCredentials", () => {
  // test_aws_access_key — :12-17
  test("test_aws_access_key", () => {
    const text = "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
    const result = scrubCredentials(text);
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).toContain("[REDACTED-AWS-ACCESS-KEY]");
  });

  // test_aws_secret_key — :19-24
  test("test_aws_secret_key", () => {
    const text = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const result = scrubCredentials(text);
    expect(result).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(result).toContain("[REDACTED-AWS-SECRET]");
  });

  // test_jwt_token — :26-31
  test("test_jwt_token", () => {
    const text =
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = scrubCredentials(text);
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(result).toContain("[REDACTED-JWT-TOKEN]");
  });

  // test_github_token — :33-38
  test("test_github_token", () => {
    const text = "GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuv";
    const result = scrubCredentials(text);
    expect(result).not.toContain("ghp_1234567890abcdefghijklmnopqrstuv");
    expect(result).toContain("[REDACTED-GITHUB-TOKEN]");
  });

  // test_password_in_connection_string — :40-45
  test("test_password_in_connection_string", () => {
    const text = "postgresql://user:mypassword123@localhost/db";
    const result = scrubCredentials(text);
    expect(result).not.toContain("mypassword123");
    expect(result).toContain("[REDACTED-PASSWORD]");
  });

  // test_private_key — :47-58
  // Build the PEM block at runtime to avoid triggering secret scanners.
  test("test_private_key", () => {
    const begin = "-----BEGIN" + " RSA PRIVATE" + " KEY-----";
    const end = "-----END" + " RSA PRIVATE" + " KEY-----";
    const body = "FAKEFAKEFAKE".repeat(4);
    const text = `${begin}\n${body}\n${end}`;
    const result = scrubCredentials(text);
    expect(result).not.toContain("FAKEFAKE");
    expect(result).toContain("[REDACTED-PRIVATE-KEY]");
  });

  // test_api_key_hex — :60-65
  test("test_api_key_hex", () => {
    const text = "api_key=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
    const result = scrubCredentials(text);
    expect(result).not.toContain("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4");
    expect(result).toContain("[REDACTED-API-KEY]");
  });

  // test_multiple_credentials — :67-80 (order-dependent: secret BEFORE api-key)
  test("test_multiple_credentials", () => {
    const text = `
        AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
        AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
        TOKEN=ghp_1234567890abcdefghijklmnopqrstuv  # gitleaks:allow
        `;
    const result = scrubCredentials(text);
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(result).not.toContain("ghp_1234567890abcdefghijklmnopqrstuv");
    expect(result).toContain("[REDACTED-AWS-ACCESS-KEY]");
    expect(result).toContain("[REDACTED-AWS-SECRET]");
    expect(result).toContain("[REDACTED-GITHUB-TOKEN]");
  });

  // test_preserves_safe_text — :82-86
  test("test_preserves_safe_text", () => {
    const text = "Hello world! This is a test message with no credentials.";
    const result = scrubCredentials(text);
    expect(result).toBe(text);
  });

  // test_empty_string — :88-90
  test("test_empty_string", () => {
    expect(scrubCredentials("")).toBe("");
  });

  // test_custom_redaction_marker — :92-97
  test("test_custom_redaction_marker", () => {
    const text = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
    const result = scrubCredentials(text, "***");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).toContain("***");
  });
});

// class TestScrubDictValues — test_credential_scrubber.py:100-151
describe("TestScrubDictValues", () => {
  // test_scrub_all_strings — :103-113
  test("test_scrub_all_strings", () => {
    const data = {
      token: "ghp_1234567890abcdefghijklmnopqrstuv",
      count: 42,
      message: "Hello world",
    };
    const result = scrubDictValues(data);
    expect(result["token"]).not.toContain("ghp_1234567890abcdefghijklmnopqrstuv");
    expect(result["count"]).toBe(42);
    expect(result["message"]).toBe("Hello world");
  });

  // test_scrub_specific_keys — :115-124
  test("test_scrub_specific_keys", () => {
    const data = {
      token: "ghp_1234567890abcdefghijklmnopqrstuv",
      message: "ghp_1234567890abcdefghijklmnopqrstuv",
    };
    const result = scrubDictValues(data, new Set(["token"]));
    expect(result["token"]).not.toContain("ghp_1234567890abcdefghijklmnopqrstuv");
    // message should NOT be scrubbed since we only targeted "token"
    expect(result["message"]).toBe("ghp_1234567890abcdefghijklmnopqrstuv");
  });

  // test_recursive_scrubbing — :126-137
  test("test_recursive_scrubbing", () => {
    const data = {
      outer: {
        inner: {
          secret: "AKIAIOSFODNN7EXAMPLE",
        },
      },
    };
    const result = scrubDictValues(data);
    const inner = (result["outer"] as Record<string, Record<string, string>>)["inner"]!;
    expect(inner["secret"]).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(inner["secret"]).toContain("[REDACTED-AWS-ACCESS-KEY]");
  });

  // test_list_values — :139-151
  test("test_list_values", () => {
    const data = {
      tokens: [
        "ghp_1234567890abcdefghijklmnopqrstuv",
        "safe text",
        { nested: "ghp_abcdefghijklmnopqrstuvwxyz123456" },
      ],
    };
    const result = scrubDictValues(data);
    const tokens = result["tokens"] as unknown[];
    expect(tokens[0] as string).not.toContain("ghp_1234567890abcdefghijklmnopqrstuv");
    expect(tokens[1]).toBe("safe text");
    const nested = tokens[2] as Record<string, string>;
    expect(nested["nested"]).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
  });
});
