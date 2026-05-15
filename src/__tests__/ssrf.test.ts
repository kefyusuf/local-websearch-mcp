import { describe, it, expect } from "vitest";

const privateIpRegex = /^(localhost|127\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/;

function isBlocked(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return privateIpRegex.test(hostname);
  } catch {
    return false;
  }
}

describe("SSRF Protection", () => {
  it("should block localhost", () => {
    expect(isBlocked("http://localhost:8080")).toBe(true);
    expect(isBlocked("http://localhost")).toBe(true);
  });

  it("should block loopback addresses", () => {
    expect(isBlocked("http://127.0.0.1")).toBe(true);
    expect(isBlocked("http://127.0.0.1:3000/api")).toBe(true);
  });

  it("should block private ranges", () => {
    expect(isBlocked("http://10.0.0.1")).toBe(true);
    expect(isBlocked("http://172.16.0.1")).toBe(true);
    expect(isBlocked("http://192.168.1.1/admin")).toBe(true);
  });

  it("should allow public URLs", () => {
    expect(isBlocked("https://google.com")).toBe(false);
    expect(isBlocked("https://example.com/page")).toBe(false);
    expect(isBlocked("https://api.github.com")).toBe(false);
  });
});
