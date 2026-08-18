public class MyClass {
    public Integer add(Integer a, Integer b) {
        // now with logging
        System.debug('adding');
        return a + b;
    }

    public Integer multiply(Integer a, Integer b) {
        return a * b;
    }
}
