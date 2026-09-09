import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoverageGapsNote } from '../src/components/dependencies/CoverageGapsNote';

describe('CoverageGapsNote', () => {
  it('renders nothing when there are no gaps', () => {
    const { container } = render(<CoverageGapsNote gaps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the gap count collapsed by default, and reveals full text on click', async () => {
    const user = userEvent.setup();
    render(<CoverageGapsNote gaps={['Gap one text', 'Gap two text']} />);

    expect(screen.getByText(/2 known coverage gaps/)).toBeInTheDocument();
    expect(screen.queryByText('Gap one text')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button'));

    expect(screen.getByText('Gap one text')).toBeInTheDocument();
    expect(screen.getByText('Gap two text')).toBeInTheDocument();
  });

  it('singularizes the count for exactly one gap', () => {
    render(<CoverageGapsNote gaps={['Only gap']} />);
    expect(screen.getByText(/1 known coverage gap$/)).toBeInTheDocument();
  });
});
