import { PAGE_META } from '@/lib/page-meta';

export const metadata = PAGE_META.book;

export default function BookLayout({ children }: { children: React.ReactNode }) {
  return children;
}
