import cloudinary from "./cloudinary.js";
import type { DocumentKind, SniffedFile } from "./applicationDocuments.js";

// Private storage for application documents. Unlike receipts (public Cloudinary URLs), these are
// uploaded with type "authenticated": there is no public URL, and the only way to read one is a
// signed download link that expires in minutes, generated for a SuperAdmin on request.
// Kept behind this small interface so tests can replace it.

export interface StoredFile {
  publicId: string;
  resourceType: "image" | "raw";
  format: string;
  bytes: number;
}

const SIGNED_LINK_SECONDS = 5 * 60;

export const documentStorage = {
  put(buffer: Buffer, options: { requestId: string; kind: DocumentKind; sniffed: SniffedFile }): Promise<StoredFile> {
    // PDFs are stored as raw files: no transformations are needed, and raw downloads aren't
    // subject to the account's PDF delivery setting.
    const resourceType = options.sniffed.format === "pdf" ? "raw" : "image";
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          type: "authenticated",
          resource_type: resourceType,
          folder: `easybuy/application-documents/${options.requestId}/${options.kind}`,
          unique_filename: true,
          use_filename: false,
          overwrite: false,
          ...(resourceType === "raw" ? { format: "pdf" } : {}),
        },
        (error, result) => {
          if (error || !result) return reject(error ?? new Error("upload failed"));
          resolve({ publicId: result.public_id, resourceType, format: result.format || options.sniffed.format, bytes: result.bytes });
        },
      );
      stream.end(buffer);
    });
  },

  /** A download link valid for a few minutes. */
  signedLink(file: StoredFile): string {
    return cloudinary.utils.private_download_url(file.publicId, file.format, {
      resource_type: file.resourceType,
      type: "authenticated",
      expires_at: Math.floor(Date.now() / 1000) + SIGNED_LINK_SECONDS,
      attachment: false,
    });
  },

  async remove(file: StoredFile): Promise<void> {
    await cloudinary.uploader.destroy(file.publicId, { resource_type: file.resourceType, type: "authenticated", invalidate: true });
  },
};
