export interface SecretStringCodec {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class MissingSecretCodec implements SecretStringCodec {
  encrypt(value: string): string {
    if (!value) return "";
    throw new Error("Secret encryption codec is not configured.");
  }

  decrypt(value: string): string {
    if (!value) return "";
    throw new Error("Secret encryption codec is not configured.");
  }
}

export class SafeStorageSecretCodec implements SecretStringCodec {
  constructor(private readonly safeStorage: SafeStorageLike) {}

  encrypt(value: string): string {
    if (!value) return "";
    this.assertEncryptionAvailable();
    return this.safeStorage.encryptString(value).toString("base64");
  }

  decrypt(value: string): string {
    if (!value) return "";
    this.assertEncryptionAvailable();
    return this.safeStorage.decryptString(Buffer.from(value, "base64"));
  }

  private assertEncryptionAvailable(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Secret encryption is unavailable for model API keys.");
    }
  }
}
