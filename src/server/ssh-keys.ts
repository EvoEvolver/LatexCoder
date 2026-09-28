import { createHash } from "node:crypto";
import ssh2 from "ssh2";
import { apiError } from "./core.ts";

const { utils } = ssh2;

export function sshFingerprint(publicKey: Buffer): string {
  return `SHA256:${createHash("sha256").update(publicKey).digest("base64").replace(/=+$/, "")}`;
}

export function parseSshPublicKey(value: unknown): { publicKey: string; fingerprint: string } {
  if (typeof value !== "string" || value.length > 16_384
    || !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/.test(value.trim())) {
    throw apiError("invalid_ssh_key", "Enter an OpenSSH public key (Ed25519, RSA, or ECDSA). Never upload a private key.", 400);
  }
  const parsed = utils.parseKey(value.trim());
  if (parsed instanceof Error || Array.isArray(parsed) || parsed.isPrivateKey()) {
    throw apiError("invalid_ssh_key", "The SSH public key is invalid.", 400);
  }
  const data = parsed.getPublicSSH();
  return { publicKey: `${parsed.type} ${data.toString("base64")}`, fingerprint: sshFingerprint(data) };
}
