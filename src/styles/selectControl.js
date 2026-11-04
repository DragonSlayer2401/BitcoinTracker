import './selectControl.scss';

export const selectClassNames = {
  control: ({ isFocused, isDisabled }) =>
    'schedule-select-control' +
    (isFocused ? ' schedule-select-focused' : '') +
    (isDisabled ? ' schedule-select-disabled' : ''),
  valueContainer: () => 'schedule-select-value',
  singleValue: () => 'schedule-select-selection',
  dropdownIndicator: () => 'schedule-select-arrow',
  menuPortal: () => 'schedule-select-menu-portal',
  menu: () => 'schedule-select-menu',
  menuList: () => 'schedule-select-options',
  option: ({ isFocused, isSelected }) =>
    'schedule-select-option' +
    (isFocused ? ' schedule-option-focused' : '') +
    (isSelected ? ' schedule-option-selected' : ''),
};
