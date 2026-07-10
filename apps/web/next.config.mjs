const configuredApiOrigin = process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL;

if (!configuredApiOrigin && process.env.NODE_ENV === "production") {
  throw new Error(
    "INTERNAL_API_URL or NEXT_PUBLIC_API_URL must be set for production builds; refusing to fall back to http://localhost:8080",
  );
}

const API_ORIGIN = configuredApiOrigin ?? "http://localhost:8080";

const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_ORIGIN}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
