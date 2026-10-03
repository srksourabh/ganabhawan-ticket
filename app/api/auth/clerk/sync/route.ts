import { auth, currentUser as clerkCurrentUser } from '@clerk/nextjs/server';
import { ensureUserFromClerk, verifiedClerkEmail } from '@/lib/auth';
import { jsonOk, jsonError } from '@/lib/http';
import { AppError } from '@/lib/errors';

export async function POST(): Promise<Response> {
  try {
    const session = await auth();
    if (!session.userId) throw new AppError(401, 'Please sign in with Google or Clerk first.');
    const clerkUser = await clerkCurrentUser();
    if (!clerkUser) throw new AppError(401, 'Clerk session not found.');
    const email = verifiedClerkEmail(clerkUser);
    if (!email) throw new AppError(400, 'Your Google account must include a verified email address.');
    const name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ').trim();
    const user = await ensureUserFromClerk(clerkUser.id, email, name);
    return jsonOk({ id: user.id, contact: user.contact, name: user.name, role: user.role });
  } catch (error) {
    return jsonError(error);
  }
}
