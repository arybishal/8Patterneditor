export const TOOLS = Object.freeze([
    { id: 'adjust', label: 'Adjust' },
    { id: 'film', label: 'Film' },
    { id: 'effects', label: 'Effects' },
    { id: 'mask', label: 'Mask' },
    { id: 'crop', label: 'Crop' },
    { id: 'rotate', label: 'Rotate' },
    { id: 'text', label: 'Text' },
    { id: 'export', label: 'Export' },
]);

export function toolLabel(id) {
    return TOOLS.find((tool) => tool.id === id)?.label ?? id;
}
