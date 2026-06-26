const clientRoot = __dirname;

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  turbopack: {
    root: clientRoot,
  },
  outputFileTracingRoot: clientRoot,
};

module.exports = nextConfig;
