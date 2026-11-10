"""One byte range of a file, as browsers ask for it to play video or resume a download."""
import re

RANGE = re.compile(r'^bytes=(\d*)-(\d*)$')


def byte_range(header, size):
    """The (start, end) bytes, end included, that a Range header asks for in a file of size
    bytes; None when there is no usable single range (the whole file is sent); 'unsatisfiable'
    when the range lies wholly outside the file."""
    if not header: return None
    match = RANGE.match(header.strip())
    if not match or match[1] == match[2] == '': return None
    if match[1] == '':
        length = int(match[2])
        if length == 0: return 'unsatisfiable'
        return (max(0, size - length), size - 1) if size else 'unsatisfiable'
    start = int(match[1])
    if start >= size: return 'unsatisfiable'
    end = int(match[2]) if match[2] else size - 1
    if end < start: return None
    return start, min(end, size - 1)


class Part:
    """Reads at most length bytes of an open file, from where it was positioned."""
    def __init__(self, source, length):
        self.source, self.left = source, length

    def read(self, amount=-1):
        if self.left <= 0: return b''
        amount = self.left if amount is None or amount < 0 else min(amount, self.left)
        data = self.source.read(amount)
        self.left -= len(data)
        return data

    def close(self): self.source.close()
