import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
  api: {
    sizeProfileSave: vi.fn(),
  },
  postNativeMessage: vi.fn(),
}));

import { api, postNativeMessage } from '@/lib/api';
import MySizeView from '@/components/community/MySizeView';

const MEMBER = {
  id: 'member-1',
  size_profile: {
    method: 'known',
    known_size_system: 'UK',
  },
};

describe('MySizeView notification bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('nudges the native shell only after points are actually awarded', async () => {
    const user = userEvent.setup();
    api.sizeProfileSave.mockResolvedValue({
      profile: { method: 'known', known_size_system: 'UK', known_size: '8-10' },
      points_awarded: true,
      points_awarded_value: 15,
    });

    render(<MySizeView member={MEMBER} onBack={vi.fn()} onMemberUpdate={vi.fn()} />);
    await user.selectOptions(screen.getByTestId('my-size-known-size'), '8-10');
    await user.click(screen.getByTestId('my-size-save'));

    await waitFor(() => {
      expect(postNativeMessage).toHaveBeenCalledWith('notification-moment', {
        moment: 'points-awarded',
      });
    });
  });

  it('does not nudge when saving earns no points', async () => {
    const user = userEvent.setup();
    api.sizeProfileSave.mockResolvedValue({
      profile: { method: 'known', known_size_system: 'UK', known_size: '8-10' },
      points_awarded: false,
    });

    render(<MySizeView member={MEMBER} onBack={vi.fn()} onMemberUpdate={vi.fn()} />);
    await user.selectOptions(screen.getByTestId('my-size-known-size'), '8-10');
    await user.click(screen.getByTestId('my-size-save'));

    await waitFor(() => expect(api.sizeProfileSave).toHaveBeenCalledTimes(1));
    expect(postNativeMessage).not.toHaveBeenCalled();
  });
});