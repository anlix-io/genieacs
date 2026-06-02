export const DeletedValue = Symbol('DeletedValue');
export type Deleted = typeof DeletedValue;
export type CachedPrimitive =
  boolean | string | number | undefined | Deleted;
export type CachedValue = CachedPrimitive | { [key: string]: CachedValue };
export type CachedValues = { [key: string]: CachedValue };

/**
 * This is a map to undo the revision logic from genie. It stores the "revision"
 * like value. It is basically an array of objects, each object is a map of the
 * path (TR-069 parameter path) and the value in that iteration.
 * 
 * Each setValue, addObject or deleteObject will increment the revision.
 * 
 * When getting a value, it will return the value of the latest revision that
 * got/changed this value, otherwise it will return undefined.
 */
export class IterationMapCache {
  private declare currentRevision: number;
  private declare valueCache: CachedValues[];

  private readonly SIZE_OBJECT_SUFFIX = '__size';

  public constructor() {
    this.currentRevision = 0;
    this.valueCache = [];
  }

  private traversePath(
    path: string,
    revision?: CachedValues,
  ): boolean | string | number | undefined | Deleted {
    // If there's no revision provided, nothing to read.
    if (!revision) return undefined;

    const parts = path.split('.');
    let current: CachedValues | CachedPrimitive = revision;

    // Loop the part of the path
    for (const part of parts) {
      // Continue if the path part is an empty string
      if (part === '') continue;

      // Return early if the part is not found in the current revision
      if (current[part] === undefined) return undefined;

      // Return early if the part is marked as deleted
      if (current[part] === DeletedValue) return DeletedValue;

      // Continue traversing
      current = current[part] as CachedValues;
    }

    // Return if found
    if (
      typeof current === 'boolean' ||
      typeof current === 'string' ||
      typeof current === 'number'
    ) return current;

    return undefined;
  }

  /**
   * Try getting the value of the path in the latest revision, if not found, try
   * the previous revision and so on until it finds a value or reaches the first
   * revision.
   *
   * @param path The TR-069 parameter path to get the value for.
   * @param previousRevisionSearch Whether to search in the previous revisions
   * if the value is not found in the latest revision.
   *
   * @returns The value of the parameter in the latest revision, or undefined if
   * not found.
   */
  public getValue(
    path: string,
    previousRevisionSearch = true,
  ): boolean | string | number | undefined {
    // If we only have to search in the latest revision, we can return early
    // without looping
    if (!previousRevisionSearch) {
      const value = this.traversePath(
        path,
        this.valueCache[this.currentRevision],
      );

      // If the value is marked as deleted, return undefined
      if (value === DeletedValue) return undefined;

      // If the value is found and is not an object, return it, otherwise return
      // undefined
      if (value !== undefined && typeof value !== 'object') return value;
      return undefined;
    }

    // Otherwise, loop the revisions until we find a value or reach the first
    // revision
    for (let revision = this.currentRevision; revision >= 0; --revision) {
      const value = this.traversePath(path, this.valueCache[revision]);
      if (value === DeletedValue) return undefined;
      if (value !== undefined && typeof value !== 'object') return value;
    }

    return undefined;
  }

  /**
   * Save the value of the path in the current revision.
   *
   * @param path The TR-069 parameter path to save the value for.
   * @param value The value to save.
   */
  public saveValue(
    path: string,
    value: boolean | string | number | Deleted,
  ): void {
    if (!this.valueCache[this.currentRevision])
      this.valueCache[this.currentRevision] = {};

    // Split the path into parts and create nested objects if needed
    const parts = path.split('.').filter((part: string) => part !== '');
    let current: CachedValues = this.valueCache[this.currentRevision];

    // Loop the part of the path except the last one
    for (let partIndex = 0; partIndex < parts.length - 1; ++partIndex) {
      const part = parts[partIndex]?.trim() ?? '';

      // Continue if the path part is an empty string
      if (part === '') continue;

      // If the part is not found in the current revision or is not an object,
      // create a new object
      if (current[part] === undefined || typeof current[part] !== 'object')
        current[part] = {};

      // Continue traversing the path
      current = current[part] as CachedValues;
    }

    // Assign the value to the last part of the path
    const lastPart = parts[parts.length - 1];
    current[lastPart] = value;
  }

  /**
   * Increment the revision. This should be called after each setValue,
   * addObject or deleteObject operation to ensure that the next changes are
   * stored in a new revision.
   */
  public incrementRevision(): void {
    this.currentRevision += 1;
    if (!this.valueCache[this.currentRevision])
      this.valueCache[this.currentRevision] = {};
  }

  /**
   * Decrement the revision. This should be called to move back to the previous
   * revision if needed.
   */
  public decrementRevision(): void {
    if (this.currentRevision > 0) this.currentRevision -= 1;
  }

  /**
   * Reset the revision to 0. This can be used to start a new iteration
   */
  public resetRevision(): void {
    this.currentRevision = 0;
  }

  /**
   * Get the value of the added object at the given path in the latest revision.
   *
   * @param path The TR-069 parameter path to get the added object value for.
   * @returns The value of the added object in the latest revision, or undefined
   * if not found.
   */
  public getAddObjectValue(
    path: string,
  ): boolean | string | number | undefined {
    this.incrementRevision();
    if (!path.endsWith('.')) path += '.';

    // Check if we must return or let it add again
    const shouldAdd =
      this.getValue(path + this.SIZE_OBJECT_SUFFIX, false) === undefined;

    // Return the last size if it exists
    return shouldAdd ?
      undefined :
      this.getValue(path + this.SIZE_OBJECT_SUFFIX);
  }

  /**
   * Get the value of the deleted object at the given path in the latest
   * revision.
   *
   * @param path The TR-069 parameter path to get the deleted object value for.
   * @returns The value of the deleted object in the latest revision, or
   * undefined if not found.
   */
  public getDeleteObjectValue(
    path: string,
  ): boolean | string | number | undefined {
    this.incrementRevision();

    // Get the last part of the path
    const lastPart = path
      .split('.')
      .filter((part: string) => part !== '')
      .slice(-1)[0];

    // If it ends with a number, change it to *
    if (lastPart && !isNaN(Number(lastPart)))
      path = path.slice(0, -lastPart.length) + '*';

    // If not trailing dot, add it
    if (!path.endsWith('.')) path += '.';

    // Check if we must return or let it delete again
    const shouldDelete =
      this.getValue(path + this.SIZE_OBJECT_SUFFIX, false) === undefined;

    // Return the last size if it exists
    return shouldDelete ?
      undefined :
      this.getValue(path + this.SIZE_OBJECT_SUFFIX);
  }

  /**
   * Get the size of the object at the given path in the revisions
   *
   * @param path - The TR-069 parameter path to get the object size for.
   */
  public getObjectSize(path: string): boolean | string | number | undefined {
    // Get the last part of the path
    const lastPart = path
      .split('.')
      .filter((part: string) => part !== '')
      .slice(-1)[0];

    // If it ends with a number, change it to *
    if (lastPart && !isNaN(Number(lastPart)))
      path = path.slice(0, -lastPart.length) + '*';

    // If not trailing dot, add it
    if (!path.endsWith('.')) path += '.';
    return this.getValue(path + this.SIZE_OBJECT_SUFFIX);
  }

  /**
   * Get the value of the setted value at the given path in the latest revision.
   *
   * @param path The TR-069 parameter path to get the setted value for.
   * @returns The value of the setted value in the latest revision, or
   * undefined if not found.
   */
  public getSettedValue(path: string): boolean | string | number | undefined {
    this.incrementRevision();
    return this.getValue(path);
  }

  /**
   * Set the value of the path and increment the revision. This is a convenience
   * method that combines saveValue and incrementRevision, so that you can set a
   * value and automatically move to the next revision.
   *
   * @param path The TR-069 parameter path to set the value for.
   * @param value The value to set.
   */
  public setValue(
    path: string, value: boolean | string | number
  ): void {
    this.saveValue(path, value);
  }

  /**
   * Add an object at the given path with the given value.
   *
   * @param path The TR-069 parameter path to add the object at.
   * @param amount The amount of the object to add.
   */
  public addObject(path: string, amount: boolean | string | number): void {
    if (!path.endsWith('.')) path += '.';
    this.saveValue(path + this.SIZE_OBJECT_SUFFIX, amount);
  }

  /**
   * Delete an object at the given path. It also clears all the values that
   * start with the path in the current revision to avoid returning already
   * deleted objects/values.
   *
   * @param path The TR-069 parameter path to delete the object at.
   * @param amount The amount of the object to delete.
   */
  public deleteObject(path: string, amount: boolean | string | number): void {
    // Clear the structure of the deleted object in the current revision to
    // avoid returning already deleted objects/values
    // Build the path with DeletedValue in the last part to mark it as deleted
    const basePath = path.split('*')[0];
    this.saveValue(basePath, DeletedValue);

    // Get the last part of the path
    const lastPart = path
      .split('.')
      .filter((part: string) => part !== '')
      .slice(-1)[0];

    // If it ends with a number, change it to *
    if (lastPart && !isNaN(Number(lastPart)))
      path = path.slice(0, -lastPart.length) + '*';

    // If not trailing dot, add it
    if (!path.endsWith('.')) path += '.';

    // Save the amount to return it when getDeleteObjectValue is called with the
    // path of the deleted
    this.saveValue(path + this.SIZE_OBJECT_SUFFIX, amount);
  }
}
