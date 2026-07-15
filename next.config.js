/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // unpdf bundles a pdf.js build for PDF text extraction (orders PDF-attachment
  // parsing). Keep it external so Next doesn't try to bundle its worker/wasm
  // into the serverless function — the recommended setup for pdf libs.
  experimental: {
    serverComponentsExternalPackages: ["unpdf"],
  },
};

module.exports = nextConfig;
