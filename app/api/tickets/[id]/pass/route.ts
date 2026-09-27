import { authenticated } from '@/lib/auth';
import { ticketPass } from '@/lib/tickets';
import { jsonError, jsonOk } from '@/lib/http';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = await authenticated();
    const { id } = await params;
    return jsonOk(await ticketPass(user, id));
  } catch (error) {
    return jsonError(error);
  }
}
