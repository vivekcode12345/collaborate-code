// Starter code per language, shared by the collaboration screen and the
// interview screen (the candidate's editor uses the same templates).
export const TEMPLATES = {
    javascript: `// Hello World
console.log("Hello, World!");`,
    python: `# Hello World
print("Hello, World!")`,
    java: `public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}`,
    cpp: `#include <iostream>

int main() {
    std::cout << "Hello, World!" << std::endl;
    return 0;
}`,
};

export const LANGUAGES = [
    { value: 'javascript', label: 'JavaScript' },
    { value: 'python', label: 'Python' },
    { value: 'java', label: 'Java' },
    { value: 'cpp', label: 'C++' },
];

export const isDefaultTemplate = (code) => {
    return Object.values(TEMPLATES).includes(code) || code.startsWith("// Start");
};
