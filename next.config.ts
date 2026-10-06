import type { NextConfig } from 'next';
import { SECURITY_HEADER_LIST } from './src/lib/security-headers';

const config: NextConfig = {
  serverExternalPackages: ['pg'],
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADER_LIST }];
  },
};
export default config;
