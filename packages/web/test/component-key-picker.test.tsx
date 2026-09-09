import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComponentKeyPicker } from '../src/components/dependencies/ComponentKeyPicker';

describe('ComponentKeyPicker', () => {
  it('submits the typed type + full name', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ComponentKeyPicker types={['ApexClass', 'Flow']} onSubmit={onSubmit} />);

    await user.clear(screen.getByLabelText('Full name'));
    await user.type(screen.getByLabelText('Full name'), 'OpportunityService');
    await user.click(screen.getByRole('button', { name: /Analyze impact/ }));

    expect(onSubmit).toHaveBeenCalledWith({ type: 'ApexClass', fullName: 'OpportunityService' });
  });

  it('disables submit until a full name is entered', () => {
    render(<ComponentKeyPicker types={['ApexClass']} onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Analyze impact/ })).toBeDisabled();
  });

  it('pre-fills from `initial` (e.g. re-focusing from a graph node click)', () => {
    render(<ComponentKeyPicker types={['ApexClass', 'Flow']} initial={{ type: 'Flow', fullName: 'Onboarding_Flow' }} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Full name')).toHaveValue('Onboarding_Flow');
  });

  it('trims whitespace before submitting', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ComponentKeyPicker types={['ApexClass']} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText('Full name'), '  Spaced  ');
    await user.click(screen.getByRole('button', { name: /Analyze impact/ }));

    expect(onSubmit).toHaveBeenCalledWith({ type: 'ApexClass', fullName: 'Spaced' });
  });
});
