import os

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
try:
    from depends import depends  # type: ignore

    depends(requirements)
except Exception:  # noqa: BLE001
    pass

from .IGlobal import IGlobal  # noqa: E402
from .IInstance import IInstance  # noqa: E402

__all__ = ['IGlobal', 'IInstance']
