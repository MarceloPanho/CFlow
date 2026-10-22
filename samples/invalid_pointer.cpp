int wild() {
    int x = 1;
    int* p = &x;
    *p = 2;
    p = nullptr;
    int* q = reinterpret_cast<int*>(0x10);  // endereço que o programa não pode ler
    return x + (q != nullptr);
}

int main() {
    return wild();
}
