import { describe, it, expect } from "vitest";
import { isPrivateIP, isPrivateHost } from "../ssrf.js";

describe("isPrivateIP", () => {
  it("should block loopback (127.x.x.x)", () => {
    expect(isPrivateIP("127.0.0.1")).toBe(true);
    expect(isPrivateIP("127.255.255.255")).toBe(true);
  });

  it("should block RFC 1918 10.x.x.x", () => {
    expect(isPrivateIP("10.0.0.1")).toBe(true);
    expect(isPrivateIP("10.255.255.255")).toBe(true);
  });

  it("should block RFC 1918 172.16-31.x.x", () => {
    expect(isPrivateIP("172.16.0.1")).toBe(true);
    expect(isPrivateIP("172.31.255.255")).toBe(true);
    expect(isPrivateIP("172.32.0.1")).toBe(false);
  });

  it("should block RFC 1918 192.168.x.x", () => {
    expect(isPrivateIP("192.168.1.1")).toBe(true);
    expect(isPrivateIP("192.168.255.255")).toBe(true);
  });

  it("should block link-local 169.254.x.x", () => {
    expect(isPrivateIP("169.254.1.1")).toBe(true);
  });

  it("should block CGNAT 100.64-127.x.x", () => {
    expect(isPrivateIP("100.64.0.1")).toBe(true);
    expect(isPrivateIP("100.127.255.255")).toBe(true);
    expect(isPrivateIP("100.128.0.1")).toBe(false);
  });

  it("should block current network 0.x.x.x", () => {
    expect(isPrivateIP("0.0.0.0")).toBe(true);
    expect(isPrivateIP("0.1.2.3")).toBe(true);
  });

  it("should block IPv6 loopback", () => {
    expect(isPrivateIP("::1")).toBe(true);
    expect(isPrivateIP("0:0:0:0:0:0:0:1")).toBe(true);
  });

  it("should block IPv6 ULA (fc00::/7)", () => {
    expect(isPrivateIP("fc00::1")).toBe(true);
    expect(isPrivateIP("fd00::1")).toBe(true);
  });

  it("should block IPv6 link-local (fe80::/10)", () => {
    expect(isPrivateIP("fe80::1")).toBe(true);
  });

  it("should handle IPv4-mapped IPv6", () => {
    expect(isPrivateIP("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIP("::ffff:10.0.0.1")).toBe(true);
  });

  it("should allow public IPs", () => {
    expect(isPrivateIP("8.8.8.8")).toBe(false);
    expect(isPrivateIP("1.1.1.1")).toBe(false);
    expect(isPrivateIP("142.250.80.46")).toBe(false);
  });
});

describe("isPrivateHost", () => {
  it("should block localhost string", async () => {
    expect(await isPrivateHost("localhost")).toBe(true);
    expect(await isPrivateHost("localhost6")).toBe(true);
  });

  it("should block 0.0.0.0", async () => {
    expect(await isPrivateHost("0.0.0.0")).toBe(true);
  });

  it("should block private IP strings directly", async () => {
    expect(await isPrivateHost("127.0.0.1")).toBe(true);
    expect(await isPrivateHost("192.168.1.1")).toBe(true);
    expect(await isPrivateHost("10.0.0.1")).toBe(true);
  });

  it("should allow public hostnames", async () => {
    expect(await isPrivateHost("google.com")).toBe(false);
    expect(await isPrivateHost("example.com")).toBe(false);
  });
});
