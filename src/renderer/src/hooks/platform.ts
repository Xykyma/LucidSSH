/** Единственная точка ветвления по ОС в renderer: платформа не меняется за время жизни окна. */
export const isWindows = window.lucidSSH.platform === 'win32';
