"use strict";

if (process.env.SCANBIN_LOCAL_DEMO === "1") {
  const fs = require("node:fs");
  const net = require("node:net");
  const http = require("node:http");
  const https = require("node:https");
  const http2 = require("node:http2");
  const tls = require("node:tls");
  const dns = require("node:dns");
  const dgram = require("node:dgram");
  const { syncBuiltinESMExports } = require("node:module");

  const original = {
    httpRequest: http.request,
    httpGet: http.get,
    ClientRequest: http.ClientRequest,
    httpsRequest: https.request,
    httpsGet: https.get,
    http2Connect: http2.connect,
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
    socketConnect: net.Socket.prototype.connect,
    tlsConnect: tls.connect,
    dns: new Map(),
    dgramConnect: dgram.Socket.prototype.connect,
    dgramSend: dgram.Socket.prototype.send,
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
  };

  function normalizeHost(host) {
    const value = String(host ?? "").trim().toLowerCase();
    if (/^\[[^\]]+\](?::\d+)?$/.test(value)) return value.slice(1, value.indexOf("]"));
    if (/^[^:]+:\d+$/.test(value)) return value.slice(0, value.lastIndexOf(":"));
    return value.replace(/^\[|\]$/g, "");
  }

  function isLoopback(host) {
    const normalized = normalizeHost(host);
    if (normalized === "" || normalized === "localhost" || normalized === "::1") return true;
    if (net.isIP(normalized) === 4) return normalized.startsWith("127.");
    return false;
  }

  function blocked(details) {
    const entry = {
      pid: process.pid,
      timestamp: new Date().toISOString(),
      method: String(details.method || "CONNECT").toUpperCase(),
      protocol: String(details.protocol || "unknown:").replace(/[^a-z0-9+.-:]/gi, ""),
      host: String(details.host || "").slice(0, 255),
      path: String(details.path || "/").split("?")[0].slice(0, 512),
    };
    const ledger = process.env.SCANBIN_LOCAL_DEMO_EGRESS_LEDGER;
    if (ledger) {
      try {
        fs.appendFileSync(ledger, `${JSON.stringify(entry)}\n`, { encoding: "utf8" });
      } catch (cause) {
        const ledgerError = new Error("Local tire demo blocked egress but could not persist its egress ledger.");
        ledgerError.code = "LOCAL_DEMO_EGRESS_LEDGER_FAILED";
        ledgerError.cause = cause;
        throw ledgerError;
      }
    }
    const error = new Error(`Local tire demo blocked external egress to ${entry.protocol}//${entry.host}${entry.path}`);
    error.code = "LOCAL_DEMO_EGRESS_BLOCKED";
    throw error;
  }

  function targetFromRequest(defaultProtocol, args) {
    const first = args[0];
    if (typeof first === "string" || first instanceof URL) {
      const url = new URL(first, `${defaultProtocol}://localhost`);
      return {
        protocol: url.protocol,
        host: url.hostname,
        path: url.pathname,
        method: typeof args[1] === "object" ? args[1].method : "GET",
      };
    }
    const options = first || {};
    return {
      protocol: options.protocol || `${defaultProtocol}:`,
      host: normalizeHost(options.hostname || options.host || "localhost"),
      path: options.path || "/",
      method: options.method || "GET",
    };
  }

  function guardRequest(originalFunction, protocol) {
    return function guardedRequest(...args) {
      const target = targetFromRequest(protocol, args);
      if (!isLoopback(target.host)) blocked(target);
      return originalFunction.apply(this, args);
    };
  }

  http.request = guardRequest(original.httpRequest, "http");
  http.get = guardRequest(original.httpGet, "http");
  http.ClientRequest = new Proxy(original.ClientRequest, {
    construct(target, args, newTarget) {
      const requestTarget = targetFromRequest("http", args);
      if (!isLoopback(requestTarget.host)) blocked(requestTarget);
      return Reflect.construct(target, args, newTarget);
    },
  });
  https.request = guardRequest(original.httpsRequest, "https");
  https.get = guardRequest(original.httpsGet, "https");

  http2.connect = function guardedHttp2Connect(authority, ...args) {
    const url = new URL(String(authority));
    if (!isLoopback(url.hostname)) {
      blocked({ protocol: url.protocol, host: url.hostname, path: url.pathname, method: "CONNECT" });
    }
    return original.http2Connect.call(this, authority, ...args);
  };

  function socketTarget(args) {
    const first = args[0];
    if (typeof first === "string" && !/^\d+$/.test(first)) return { localPath: true };
    if (typeof first === "object" && first !== null) {
      if (first.path && !first.port) return { localPath: true };
      return { host: first.host || "localhost", port: first.port };
    }
    return { host: args[1] || "localhost", port: first };
  }

  function guardSocket(originalFunction, protocol) {
    return function guardedSocket(...args) {
      const target = socketTarget(args);
      if (!target.localPath && !isLoopback(target.host)) {
        blocked({ protocol, host: target.host, path: `:${target.port ?? ""}`, method: "CONNECT" });
      }
      return originalFunction.apply(this, args);
    };
  }
  net.connect = guardSocket(original.netConnect, "tcp:");
  net.createConnection = guardSocket(original.netCreateConnection, "tcp:");
  net.Socket.prototype.connect = guardSocket(original.socketConnect, "tcp:");
  tls.connect = guardSocket(original.tlsConnect, "tls:");

  const dnsMethods = [
    "lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname",
    "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv",
    "resolveTxt", "reverse",
  ];
  for (const name of dnsMethods) {
    if (typeof dns[name] !== "function") continue;
    original.dns.set(name, dns[name]);
    dns[name] = function guardedDns(host, ...args) {
      if (!isLoopback(host)) blocked({ protocol: "dns:", host, path: "/", method: name });
      return original.dns.get(name).call(this, host, ...args);
    };
  }
  for (const name of Object.getOwnPropertyNames(dns.Resolver.prototype)) {
    if (name === "constructor" || typeof dns.Resolver.prototype[name] !== "function") continue;
    const originalResolverMethod = dns.Resolver.prototype[name];
    dns.Resolver.prototype[name] = function guardedResolver(host, ...args) {
      if (!isLoopback(host)) blocked({ protocol: "dns:", host, path: "/", method: name });
      return originalResolverMethod.call(this, host, ...args);
    };
  }
  if (dns.promises) {
    for (const name of dnsMethods) {
      if (typeof dns.promises[name] !== "function") continue;
      const originalPromise = dns.promises[name].bind(dns.promises);
      dns.promises[name] = async function guardedDnsPromise(host, ...args) {
        if (!isLoopback(host)) blocked({ protocol: "dns:", host, path: "/", method: name });
        return originalPromise(host, ...args);
      };
    }
    for (const name of Object.getOwnPropertyNames(dns.promises.Resolver.prototype)) {
      if (name === "constructor" || typeof dns.promises.Resolver.prototype[name] !== "function") continue;
      const originalResolverPromise = dns.promises.Resolver.prototype[name];
      dns.promises.Resolver.prototype[name] = async function guardedResolverPromise(host, ...args) {
        if (!isLoopback(host)) blocked({ protocol: "dns:", host, path: "/", method: name });
        return originalResolverPromise.call(this, host, ...args);
      };
    }
  }

  dgram.Socket.prototype.connect = function guardedDgramConnect(port, address = "localhost", ...args) {
    if (!isLoopback(address)) blocked({ protocol: "udp:", host: address, path: `:${port}`, method: "CONNECT" });
    this.__scanbinLocalDemoHost = address;
    return original.dgramConnect.call(this, port, address, ...args);
  };
  dgram.Socket.prototype.send = function guardedDgramSend(...args) {
    let address;
    let port;
    if (typeof args[1] === "number" && typeof args[2] === "number" && typeof args[3] === "number") {
      port = args[3];
      address = typeof args[4] === "string" ? args[4] : this.__scanbinLocalDemoHost;
    } else if (typeof args[1] === "number") {
      port = args[1];
      address = typeof args[2] === "string" ? args[2] : this.__scanbinLocalDemoHost;
    } else {
      address = this.__scanbinLocalDemoHost;
    }
    if (address && !isLoopback(address)) {
      blocked({ protocol: "udp:", host: address, path: `:${port ?? ""}`, method: "SEND" });
    }
    return original.dgramSend.apply(this, args);
  };

  if (typeof original.fetch === "function") {
    globalThis.fetch = async function guardedFetch(input, init) {
      const value = input instanceof Request ? input.url : input;
      const url = new URL(String(value), "http://localhost");
      if (!isLoopback(url.hostname)) {
        blocked({
          protocol: url.protocol,
          host: url.hostname,
          path: url.pathname,
          method: init?.method || (input instanceof Request ? input.method : "GET"),
        });
      }
      return original.fetch.call(this, input, init);
    };
  }

  if (typeof original.WebSocket === "function") {
    globalThis.WebSocket = new Proxy(original.WebSocket, {
      construct(target, args, newTarget) {
        const url = new URL(String(args[0]));
        if (!isLoopback(url.hostname)) {
          blocked({ protocol: url.protocol, host: url.hostname, path: url.pathname, method: "CONNECT" });
        }
        return Reflect.construct(target, args, newTarget);
      },
    });
  }

  syncBuiltinESMExports();
}
