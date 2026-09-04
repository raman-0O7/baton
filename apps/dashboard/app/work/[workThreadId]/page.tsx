import { ThreadDetail } from '../../../components/thread-detail';

export default async function ThreadPage({
  params,
}: {
  params: Promise<{ workThreadId: string }>;
}) {
  const { workThreadId } = await params;
  return <ThreadDetail workThreadId={workThreadId} />;
}
