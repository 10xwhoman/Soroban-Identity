import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import type {
  Credential,
  CredentialType,
  RevocationReason,
  SorobanIdentityConfig,
  VerifyResult,
} from "./types";
import { REVOCATION_REASONS } from "./types";

export class CredentialClient {
  private server: SorobanRpc.Server;
  private contract: Contract;
  private config: SorobanIdentityConfig;

  constructor(config: SorobanIdentityConfig) {
    this.config = config;
    this.server = new SorobanRpc.Server(config.rpcUrl);
    this.contract = new Contract(config.credentialManagerId);
  }

  /**
   * Issue a credential to a subject. Caller must be a registered issuer.
   */
  async issueCredential(
    issuerKeypair: Keypair,
    subjectAddress: string,
    credentialType: CredentialType,
    claims: Record<string, string>,
    expiresAt = 0
  ): Promise<string> {
    const account = await this.server.getAccount(issuerKeypair.publicKey());

    // Signature is over SHA256(issuer + subject + claims) — simplified here
    const signature = issuerKeypair.sign(
      Buffer.from(JSON.stringify({ subjectAddress, claims }))
    );

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "issue_credential",
          nativeToScVal(issuerKeypair.publicKey(), { type: "address" }),
          nativeToScVal(subjectAddress, { type: "address" }),
          nativeToScVal(credentialType, { type: "symbol" }),
          nativeToScVal(claims, { type: "map" }),
          nativeToScVal(Buffer.from(signature), { type: "bytes" }),
          nativeToScVal(expiresAt, { type: "u64" })
        )
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(issuerKeypair);

    const result = await this.server.sendTransaction(prepared);
    if (result.status !== "PENDING") {
      throw new Error(`Transaction failed: ${result.status}`);
    }

    const confirmed = await this.waitForConfirmation(result.hash);
    // Returns BytesN<32> — encode as hex
    const raw = scValToNative(confirmed.returnValue!) as Uint8Array;
    return Buffer.from(raw).toString("hex");
  }

  /**
   * Revoke a credential with a standardized reason. Only the original issuer can revoke.
   */
  async revokeCredential(
    issuerKeypair: Keypair,
    credentialId: string,
    reason: RevocationReason = "Unspecified"
  ): Promise<void> {
    const account = await this.server.getAccount(issuerKeypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "revoke_credential",
          nativeToScVal(issuerKeypair.publicKey(), { type: "address" }),
          nativeToScVal(Buffer.from(credentialId, "hex"), { type: "bytes" }),
          nativeToScVal(REVOCATION_REASONS.indexOf(reason), { type: "u32" })
        )
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(issuerKeypair);
    const result = await this.server.sendTransaction(prepared);
    if (result.status !== "PENDING") {
      throw new Error(`Transaction failed: ${result.status}`);
    }
    await this.waitForConfirmation(result.hash);
  }

  /**
   * Verify a credential is valid (not revoked, not expired).
   * Returns a typed result so callers can distinguish failure reasons.
   */
  async verifyCredential(
    callerAddress: string,
    credentialId: string
  ): Promise<VerifyResult> {
    const account = await this.server.getAccount(callerAddress);
    const idBytes = Buffer.from(credentialId, "hex");

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "verify_credential",
          nativeToScVal(idBytes, { type: "bytes" })
        )
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    const result = await this.server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(result)) {
      const error: string = (result as { error: string }).error ?? "";
      if (error.includes("credential not found")) {
        return { valid: false, reason: "not_found" };
      }
      return { valid: false, reason: "unknown" };
    }

    const valid = scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as boolean;

    if (valid) return { valid: true };

    // Contract returned false — fetch the credential to determine why
    try {
      const cred = await this.getCredential(callerAddress, credentialId);
      if (cred.revoked) return { valid: false, reason: "revoked" };
      if (cred.expiresAt > 0 && Date.now() / 1000 > cred.expiresAt) {
        return { valid: false, reason: "expired" };
      }
    } catch {
      // getCredential failed — credential likely doesn't exist
      return { valid: false, reason: "not_found" };
    }

    return { valid: false, reason: "unknown" };
  }

  /**
   * Get all credentials issued to a subject address.
   */
  async getCredentialsBySubject(
    callerAddress: string,
    subjectAddress: string
  ): Promise<Credential[]> {
    const account = await this.server.getAccount(callerAddress);

    // Fetch the list of credential IDs for the subject
    const idsTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "get_subject_credentials",
          nativeToScVal(subjectAddress, { type: "address" })
        )
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    const idsResult = await this.server.simulateTransaction(idsTx);
    if (SorobanRpc.Api.isSimulationError(idsResult)) {
      throw new Error(`Simulation failed: ${idsResult.error}`);
    }

    const ids = scValToNative(
      (idsResult as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as Uint8Array[];

    if (!ids || ids.length === 0) return [];

    // Resolve each credential by ID
    const credentials = await Promise.all(
      ids.map((raw) =>
        this.getCredential(callerAddress, Buffer.from(raw).toString("hex"))
      )
    );

    return credentials;
  }

  /**
   * Get all credentials issued to a subject address.
   */
  async getCredentialsBySubject(
    callerAddress: string,
    subjectAddress: string
  ): Promise<Credential[]> {
    const account = await this.server.getAccount(callerAddress);

    // Fetch the list of credential IDs for the subject
    const idsTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "get_subject_credentials",
          nativeToScVal(subjectAddress, { type: "address" })
        )
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    const idsResult = await this.server.simulateTransaction(idsTx);
    if (SorobanRpc.Api.isSimulationError(idsResult)) {
      throw new Error(`Simulation failed: ${idsResult.error}`);
    }

    const ids = scValToNative(
      (idsResult as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as Uint8Array[];

    if (!ids || ids.length === 0) return [];

    // Resolve each credential by ID
    const credentials = await Promise.all(
      ids.map((raw) =>
        this.getCredential(callerAddress, Buffer.from(raw).toString("hex"))
      )
    );

    return credentials;
  }

  /**
   * Get a credential by ID.
   */
  async getCredential(
    callerAddress: string,
    credentialId: string
  ): Promise<Credential> {
    const account = await this.server.getAccount(callerAddress);
    const idBytes = Buffer.from(credentialId, "hex");

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "get_credential",
          nativeToScVal(idBytes, { type: "bytes" })
        )
      )
      .setTimeout(this.config.txTimeout ?? 30)
      .build();

    const result = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation failed: ${result.error}`);
    }

    return scValToNative(
      (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result!.retval
    ) as Credential;
  }

  private async waitForConfirmation(
    hash: string,
    retries = 10
  ): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse> {
    for (let i = 0; i < retries; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const status = await this.server.getTransaction(hash);
      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return status as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      }
      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error("Transaction failed on-chain");
      }
    }
    throw new Error("Transaction confirmation timeout");
  }
}
