import { Activation } from '../../components/activation';
import { Suspense } from 'react';

export default function ActivationPage() {
  return (
    <Suspense>
      <Activation />
    </Suspense>
  );
}
